import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { checkpointDeletionLog, pruneCompletedBackups, withBackupMaintenanceLock } from "@/lib/backup-maintenance";

const roots: string[] = [];
async function fixture() {
  const root = path.resolve(`data/verification/backup-maintenance-${randomUUID()}`); roots.push(root);
  const source = path.join(root, "source"), backup = path.join(root, "backups");
  await fs.mkdir(source, { recursive: true }); await fs.mkdir(backup);
  return { root, source, backup, current: path.join(source, "deletion-log.jsonl"), latest: path.join(backup, "deletion-log.latest.jsonl") };
}
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const entry = (id: string) => JSON.stringify({ id, kind: "thought", targetId: id, userId: "fixture-user", at: "2026-10-01T00:00:00.000Z" }) + "\n";
it("preserves earlier deletion intents when a source log is truncated, missing or invalid", async () => {
  const f = await fixture(); await fs.writeFile(f.latest, entry("old")); await fs.writeFile(f.current, entry("new"));
  await checkpointDeletionLog(f.backup, f.source); const combined = await fs.readFile(f.latest, "utf8");
  expect(combined).toContain('"old"'); expect(combined).toContain('"new"');
  await fs.writeFile(f.current, ""); await checkpointDeletionLog(f.backup, f.source); expect(await fs.readFile(f.latest, "utf8")).toBe(combined);
  await fs.unlink(f.current); expect((await checkpointDeletionLog(f.backup, f.source)).sourcePresent).toBe(false);
  await fs.writeFile(f.current, "{broken"); await expect(checkpointDeletionLog(f.backup, f.source)).rejects.toThrow("删除日志损坏");
  expect(await fs.readFile(f.latest, "utf8")).toBe(combined);
  expect((await fs.readdir(f.backup)).filter(name => name.endsWith(".partial") || name === ".maintenance.lock")).toEqual([]);
});
it("rejects conflicting deletion ids without replacing the durable checkpoint", async () => {
  const f = await fixture(); await fs.writeFile(f.latest, entry("same"));
  await fs.writeFile(f.current, entry("same").replace('"fixture-user"', '"different-user"'));
  await expect(checkpointDeletionLog(f.backup, f.source)).rejects.toThrow("冲突");
  expect(await fs.readFile(f.latest, "utf8")).toBe(entry("same"));
});
it("blocks concurrent checkpoint writers and leaves an interruption lock for review", async () => {
  const f = await fixture(); await fs.writeFile(f.current, entry("new"));
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const active = withBackupMaintenanceLock(f.backup, async () => { started(); await new Promise<void>(resolve => { release = resolve; }); });
  await entered; await expect(checkpointDeletionLog(f.backup, f.source)).rejects.toThrow("维护操作"); release(); await active;
  await checkpointDeletionLog(f.backup, f.source); expect(await fs.readFile(f.latest, "utf8")).toBe(entry("new"));
  await fs.mkdir(path.join(f.backup, ".maintenance.lock"));
  await expect(checkpointDeletionLog(f.backup, f.source)).rejects.toThrow("中断锁");
  expect((await fs.lstat(path.join(f.backup, ".maintenance.lock"))).isDirectory()).toBe(true);
});
it("refuses a linked maintenance directory without changing its target", async () => {
  const f = await fixture(), link = path.join(f.root, "linked"); await fs.writeFile(f.latest, entry("keep"));
  await fs.symlink(f.backup, link, "junction");
  await expect(checkpointDeletionLog(link, f.source)).rejects.toThrow("普通目录"); expect(await fs.readFile(f.latest, "utf8")).toBe(entry("keep"));
});
it("does not remove a maintenance lock whose ownership changed", async () => {
  const f = await fixture(), marker = path.join(f.backup, ".maintenance.lock", "owner.json");
  await expect(withBackupMaintenanceLock(f.backup, async () => { await fs.writeFile(marker, JSON.stringify({ token: "different-owner" })); })).rejects.toThrow("归属");
  expect(JSON.parse(await fs.readFile(marker, "utf8")).token).toBe("different-owner");
});
async function bundle(root: string, at: string, extra = false) {
  const name = `interview-${at.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`, directory = path.join(root, name);
  await fs.mkdir(directory); const values = { "database.dump": Buffer.from("fixture-dump-bytes"), "deletion-log.jsonl": Buffer.alloc(0) };
  const files = [];
  for (const [file, bytes] of Object.entries(values)) { await fs.writeFile(path.join(directory, file), bytes); files.push({ path: file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }); }
  await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({ format: "speak-backup-v1", createdAt: at, databaseMajor: 17, storageDriver: "local", files }));
  if (extra) await fs.writeFile(path.join(directory, "unregistered.txt"), "must remain"); return name;
}
it("keeps the newest valid backup after a long outage and never prunes partial or unrelated directories", async () => {
  const f = await fixture(), oldest = await bundle(f.backup, "2026-09-01T00:00:00.000Z"), newest = await bundle(f.backup, "2026-09-02T00:00:00.000Z");
  await fs.mkdir(path.join(f.backup, oldest + ".partial")); await fs.mkdir(path.join(f.backup, "personal-history"));
  await fs.writeFile(f.latest, entry("keep")); const result = await pruneCompletedBackups(f.backup, 7, Date.parse("2026-10-12T00:00:00Z"));
  expect(result.deleted).toEqual([oldest]); expect(await fs.readdir(f.backup)).toEqual(expect.arrayContaining([newest, oldest + ".partial", "personal-history", "deletion-log.latest.jsonl"]));
});
it("preserves corrupted or mixed-content bundles, and rejects invalid retention before deleting anything", async () => {
  const f = await fixture(), bad = await bundle(f.backup, "2026-09-01T00:00:00.000Z"), mixed = await bundle(f.backup, "2026-09-02T00:00:00.000Z", true);
  const valid = await bundle(f.backup, "2026-10-12T00:00:00.000Z"); await fs.writeFile(path.join(f.backup, bad, "database.dump"), "corrupted");
  await expect(pruneCompletedBackups(f.backup, 0)).rejects.toThrow("保留天数");
  const result = await pruneCompletedBackups(f.backup, 7, Date.parse("2026-10-12T00:00:00Z"));
  expect(result.deleted).toEqual([]); expect(result.skipped).toEqual(expect.arrayContaining([bad, mixed]));
  expect(await fs.readdir(f.backup)).toEqual(expect.arrayContaining([bad, mixed, valid]));
});
