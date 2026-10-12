import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createBackup, inspectBackup, type BackupOptions } from "@/lib/backup";
import { mergeDeletionLogs } from "@/lib/deletion-log";

const datedBundle = /^interview-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/;
async function directory(root: string) {
  const absolute = path.resolve(root);
  await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("备份维护目录必须为普通目录");
  return fs.realpath(absolute);
}
async function logText(file: string): Promise<string | null> {
  const info = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new Error("删除日志必须是有效的普通文件");
  return fs.readFile(file, "utf8");
}
export async function withBackupMaintenanceLock<T>(backupDirectory: string, operation: (root: string) => Promise<T>) {
  const root = await directory(backupDirectory), lock = path.join(root, ".maintenance.lock");
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("已有备份维护操作或待检查的中断锁，本次未修改备份"); throw error; }
  const token = randomUUID(), marker = path.join(lock, "owner.json");
  await fs.writeFile(marker, JSON.stringify({ token, pid: process.pid, host: hostname(), createdAt: new Date().toISOString() }), { flag: "wx", mode: 0o600, flush: true });
  try { return await operation(root); }
  finally {
    const info = await fs.lstat(lock);
    if (!info.isDirectory() || info.isSymbolicLink() || JSON.parse(await fs.readFile(marker, "utf8")).token !== token) throw new Error("维护锁归属发生变化，保留现场");
    await fs.unlink(marker); await fs.rmdir(lock);
  }
}
async function checkpoint(root: string, dataDirectory: string) {
  const target = path.join(root, "deletion-log.latest.jsonl"), previous = await logText(target);
  const current = await logText(path.join(path.resolve(dataDirectory), "deletion-log.jsonl"));
  // Preserve older deletion intents even if the source was truncated or temporarily missing.
  const merged = mergeDeletionLogs(previous ?? "", current ?? "");
  if (Buffer.byteLength(merged) > 64 * 1024 * 1024) throw new Error("合并删除日志过大，保留原检查点");
  const temporary = path.join(root, `deletion-log.latest-${randomUUID()}.partial`);
  await fs.writeFile(temporary, merged, { flag: "wx", mode: 0o600, flush: true });
  try { await fs.rename(temporary, target); }
  catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
  return { sourcePresent: current !== null, bytes: Buffer.byteLength(merged) };
}
export async function checkpointDeletionLog(backupDirectory: string, dataDirectory: string) {
  return withBackupMaintenanceLock(backupDirectory, root => checkpoint(root, dataDirectory));
}
async function prune(root: string, retentionDays: number, now: number) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365 || !Number.isFinite(now)) throw new Error("备份保留天数无效");
  const valid: { name: string; created: number }[] = [], skipped: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!datedBundle.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const target = path.join(root, entry.name);
    try {
      const inspected = await inspectBackup(target);
      valid.push({ name: entry.name, created: Date.parse(inspected.manifest.createdAt) });
    } catch { skipped.push(entry.name); }
  }
  valid.sort((a, b) => b.created - a.created || a.name.localeCompare(b.name));
  const deleted: string[] = [], cutoff = now - retentionDays * 86_400_000;
  // Always retain the newest verified backup, including after a long outage.
  for (const row of valid.slice(1)) {
    if (row.created >= cutoff) continue;
    const target = path.join(root, row.name), info = await fs.lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(target) !== target) throw new Error("备份清理目录发生变化，停止清理");
    await fs.rm(target, { recursive: true }); deleted.push(row.name);
  }
  return { deleted, skipped };
}
export async function pruneCompletedBackups(backupDirectory: string, retentionDays = 7, now = Date.now()) {
  return withBackupMaintenanceLock(backupDirectory, root => prune(root, retentionDays, now));
}
export async function runBackupMaintenance(options: BackupOptions, retentionDays = 7) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) throw new Error("备份保留天数必须为 1–365");
  if (options.storageDriver !== "local") throw new Error("完整备份维护仅支持本地录音，OSS 需要独立对象备份流程");
  return withBackupMaintenanceLock(options.backupDirectory, async root => {
    const deletionCheckpoint = await checkpoint(root, options.dataDirectory);
    const saved = await createBackup({ ...options, backupDirectory: root });
    const retention = await prune(root, retentionDays, Date.now());
    return { ...saved, deletionCheckpoint, retention };
  });
}
