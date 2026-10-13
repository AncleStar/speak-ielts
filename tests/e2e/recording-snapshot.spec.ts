import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import pg from "pg";
import { test, expect, type Page } from "@playwright/test";
import { pcmFixture } from "../../scripts/make-fixtures";

test.use({ extraHTTPHeaders: { "x-forwarded-for": "192.0.2.131" }, actionTimeout: 20000 });
type Meta = { id: string; status: string; createdAt: number; interrupted: boolean; snapshotOf?: string; recordingGuard?: string; activationId?: string };
type Stored = { meta: Meta; sequences: number[]; bytes: number; hash: string };
let owned: string[] = [];
test.beforeEach(() => { owned = []; });
test.afterEach(async ({ context }) => {
  await context.setOffline(false);
  for (const id of owned) expect([200, 404]).toContain((await context.request.delete(`/api/sessions/${id}`)).status());
});
async function login(page: Page, name: string) {
  await page.goto("/login"); await page.getByLabel("邮箱", { exact: true }).fill(`${name}@example.test`); await page.getByLabel("密码", { exact: true }).fill("Browser-test-123!");
  await page.getByRole("button", { name: "登录", exact: true }).click(); await expect(page).not.toHaveURL(/\/login$/); await page.goto("/");
  await expect.poll(() => page.evaluate(() => new Promise<boolean>(resolve => {
    const r = indexedDB.open("ielts-recordings", 2); r.onsuccess = () => { const db = r.result, tx = db.transaction("privateSession"), q = tx.objectStore("privateSession").get("current"); tx.oncomplete = () => { resolve(q.result?.consentAllowed === true); db.close(); }; }; r.onerror = () => resolve(false);
  }))).toBe(true);
}
async function create(page: Page) {
  const r = await page.request.post("/api/sessions", { data: { mode: "practice", questionId: "P2-PERSON-1", fresh: true } }); expect(r.ok()).toBe(true); const { id } = await r.json(); owned.push(id); return id as string;
}
async function view(page: Page, id: string) { const r = await page.request.get(`/api/sessions/${id}`); expect(r.ok()).toBe(true); return r.json(); }
async function rows(page: Page): Promise<Stored[]> {
  return page.evaluate(async () => {
    const result = await new Promise<{ meta: Meta[]; chunks: { recId: string; seq: number; blob: Blob }[] }>((resolve, reject) => {
      const r = indexedDB.open("ielts-recordings", 2); r.onerror = () => reject(r.error); r.onsuccess = () => { const db = r.result, tx = db.transaction(["recordings", "chunks"]), m = tx.objectStore("recordings").getAll(), c = tx.objectStore("chunks").getAll(); tx.oncomplete = () => { resolve({ meta: m.result, chunks: c.result }); db.close(); }; tx.onerror = () => reject(tx.error); };
    });
    return Promise.all(result.meta.map(async meta => { const c = result.chunks.filter(c => c.recId === meta.id).sort((a, b) => a.seq - b.seq), blob = new Blob(c.map(c => c.blob)); const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()); return { meta, sequences: c.map(c => c.seq), bytes: blob.size, hash: [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("") }; }));
  });
}
async function record(page: Page) {
  const id = await create(page), pool = new pg.Pool({ connectionString: "postgres://postgres:postgres@127.0.0.1:5545/e2e" });
  try { await pool.query("update practice_session set plan=jsonb_set(plan,'{timeScale}','1'::jsonb) where id=$1", [id]); } finally { await pool.end(); }
  await page.goto(`/interview/${id}`); await page.getByTestId("start-interview").click(); await page.getByRole("button", { name: "开始回答", exact: true }).click(); await expect(page.getByTestId("recording-indicator")).toBeVisible();
  await expect.poll(async () => (await rows(page))[0]?.sequences.length ?? 0).toBeGreaterThanOrEqual(6); return id;
}
async function seed(page: Page, sessionId: string, status: "pending" | "recording", sequences = [0]) {
  const recId = "snapshot_" + crypto.randomUUID();
  await page.evaluate(async ({ sessionId, recId, status, bytes, sequences }) => {
    await new Promise<void>((resolve, reject) => { const r = indexedDB.open("ielts-recordings", 2); r.onsuccess = () => { const db = r.result, tx = db.transaction(["privateSession", "recordings", "chunks"], "readwrite"), q = tx.objectStore("privateSession").get("current"); q.onsuccess = () => { const s = q.result; if (!s?.consentAllowed) { tx.abort(); return; } tx.objectStore("recordings").put({ id: recId, userId: s.userId, localEpoch: s.epoch, consentVersion: s.consentVersion, sessionId, planIndex: 0, kind: "main", followUpId: null, promptText: "Synthetic local snapshot", mimeType: "audio/wav", createdAt: Date.now(), durationMs: 6000, status, interrupted: status === "pending" }); for (const seq of sequences) tx.objectStore("chunks").put({ recId, seq, blob: new Blob([new Uint8Array(bytes)], { type: "audio/wav" }) }); }; tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); }; });
  }, { sessionId, recId, status, bytes: [...pcmFixture(6)], sequences });
  await page.goto("/"); await expect(page.getByTestId("local-recording-" + recId)).toBeVisible(); return recId;
}
async function backup(page: Page, recId: string, name: string) {
  const downloading = page.waitForEvent("download"); await page.getByTestId("local-recording-" + recId).getByRole("button", { name, exact: true }).click(); const d = await downloading;
  expect(await d.failure()).toBeNull(); const file = await d.path(); expect(file).not.toBeNull(); return fs.readFile(file!);
}

test("unverified legacy recording retains durable original, downloads exact bytes and completes a partial upload and fresh retry", async ({ page, context }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message)); await login(page, "snapshot-legacy"); const id = await record(page), originalId = (await rows(page))[0].meta.id;
  const crashed = page.waitForEvent("crash"), cdp = await context.newCDPSession(page); void cdp.send("Page.crash").catch(() => {}); await crashed; await page.close();
  const reopened = await context.newPage(); reopened.on("pageerror", e => errors.push(e.message)); await reopened.goto("/");
  // Only this synthetic account's row: emulate an older recording that cannot prove its owner stopped.
  await reopened.evaluate(recId => new Promise<void>((resolve, reject) => { const r = indexedDB.open("ielts-recordings", 2); r.onsuccess = () => { const db = r.result, tx = db.transaction("recordings", "readwrite"), q = tx.objectStore("recordings").get(recId); q.onsuccess = () => { const m = q.result; delete m.recordingGuard; delete m.activationId; tx.objectStore("recordings").put(m); }; tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); }; }), originalId);
  const original = (await rows(reopened)).find(r => r.meta.id === originalId)!; expect(original.bytes).toBeGreaterThan(0);
  await reopened.goto(`/interview/${id}`); const item = reopened.getByTestId("local-recording-" + originalId); await expect(item.getByRole("button", { name: "保留中断副本", exact: true })).toBeEnabled();
  await expect(item.getByRole("button", { name: "恢复中断片段", exact: true })).toBeDisabled(); await expect(item.getByRole("button", { name: "丢弃片段", exact: true })).toBeDisabled();
  await context.setOffline(true); await item.getByRole("button", { name: "保留中断副本", exact: true }).click();
  await expect.poll(async () => (await rows(reopened)).filter(r => r.meta.snapshotOf === originalId).length).toBe(1);
  const copy = (await rows(reopened)).find(r => r.meta.snapshotOf === originalId)!; expect(copy).toMatchObject({ bytes: original.bytes, hash: original.hash, meta: { status: "pending", interrupted: true, createdAt: original.meta.createdAt } });
  expect((await rows(reopened)).find(r => r.meta.id === originalId)).toEqual(original);
  await item.getByRole("button", { name: "保留中断副本", exact: true }).click(); await expect(reopened.getByText("中断副本已保留", { exact: false })).toBeVisible(); expect((await rows(reopened)).filter(r => r.meta.snapshotOf === originalId)).toHaveLength(1);
  const audio = reopened.locator('audio[aria-label="本机中断录音回放"]'); await expect(audio).toBeVisible(); await audio.evaluate((e: HTMLAudioElement) => e.play()); await expect.poll(() => audio.evaluate((e: HTMLAudioElement) => e.ended), { timeout: 20000 }).toBe(true);
  const downloaded = await backup(reopened, copy.meta.id, "下载录音"); expect(createHash("sha256").update(downloaded).digest("hex")).toBe(original.hash);
  const raw = JSON.parse((await backup(reopened, originalId, "下载原始备份")).toString()); expect(raw.format).toBe("speak-local-recording-v1"); expect(raw.chunks.map((c: { sequence: number }) => c.sequence)).toEqual(original.sequences);
  expect(createHash("sha256").update(Buffer.concat(raw.chunks.map((c: { base64: string }) => Buffer.from(c.base64, "base64")))).digest("hex")).toBe(original.hash);
  for (const key of ["userId", "localEpoch", "consentVersion", "activationId", "apiKey"]) expect(JSON.stringify(raw)).not.toContain(`"${key}"`);
  await reopened.setViewportSize({ width: 320, height: 740 }); expect(await reopened.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await reopened.screenshot({ path: "data/verification/round21-snapshot-320.png", fullPage: true }); await context.setOffline(false);
  const before = await view(reopened, id); await reopened.getByRole("button", { name: "结束当前练习", exact: true }).click(); await reopened.getByRole("button", { name: "取消", exact: true }).click(); expect((await view(reopened, id)).session.stateVersion).toBe(before.session.stateVersion);
  await reopened.getByRole("button", { name: "结束当前练习", exact: true }).click(); await reopened.getByRole("button", { name: "确认结束这次练习", exact: true }).click(); await expect(reopened.getByTestId("interview-room")).toHaveAttribute("data-phase", "closed");
  expect((await view(reopened, id)).session.status).toBe("paused"); expect((await rows(reopened)).find(r => r.meta.id === originalId)).toEqual(original);
  const copyItem = reopened.getByTestId("local-recording-" + copy.meta.id); await copyItem.getByRole("button", { name: "重试上传", exact: true }).click();
  await expect.poll(async () => (await view(reopened, id)).answers.some((a: { status: string; recordingSource: string; interrupted: boolean }) => a.status === "done" && a.recordingSource === "local_snapshot" && a.interrupted), { timeout: 45000 }).toBe(true);
  const saved = await view(reopened, id); expect(saved.answers).toHaveLength(1); const detail = await (await reopened.request.get(`/api/answers/${saved.answers[0].id}`)).json(); expect(detail.answer.durationMs).toBeGreaterThan(1000); expect(detail.answer.hasAudio).toBe(true);
  // Recreating the same prefix after upload is idempotent on the server too.
  await item.getByRole("button", { name: "保留中断副本", exact: true }).click(); await expect(copyItem).toBeVisible(); await copyItem.getByRole("button", { name: "重试上传", exact: true }).click(); await expect(copyItem).toHaveCount(0); expect((await view(reopened, id)).answers).toHaveLength(1);
  const pool = new pg.Pool({ connectionString: "postgres://postgres:postgres@127.0.0.1:5545/e2e" });
  try { const { rows: holds } = await pool.query("select settled, used_seconds from quota_hold where session_id=$1", [id]); expect(holds.every(h => h.settled)).toBe(true); expect(holds.reduce((n, h) => n + h.used_seconds, 0)).toBe(Math.ceil(detail.answer.durationMs / 1000)); } finally { await pool.end(); }
  await reopened.getByRole("button", { name: "重新练习此题", exact: true }).click(); await expect(reopened).not.toHaveURL(new RegExp(`/interview/${id}$`)); await expect(reopened).toHaveURL(/\/interview\//); const fresh = reopened.url().split("/interview/")[1]; expect(fresh).not.toBe(id); owned.push(fresh); await expect(reopened.getByTestId("start-interview")).toBeEnabled(); expect((await view(reopened, fresh)).plan.items[0].questionId).toBe("P2-PERSON-1");
  expect((await rows(reopened)).find(r => r.meta.id === originalId)).toEqual(original); expect(errors).toEqual([]);
  await fs.writeFile("data/verification/round21-snapshot-legacy.json", JSON.stringify({ passed: true, actualIndexedDB: true, actualMediaRecorder: true, originalImmutable: true, duplicateCopyIdempotent: true, actualPlaybackEnded: true, exactAudioDownload: true, exactRawBackup: true, privateIdentityNotExported: true, explicitEndCancelSafe: true, reservedPlanReleased: true, actualServerDecode: true, source: "local_snapshot", interrupted: true, sameQuestionFreshRetry: true, paidCalls: 0 }, null, 2));
});

test("copying a live recorder does not stop it or mutate its growing original", async ({ page, context }) => {
  await login(page, "snapshot-live"); await record(page); const original = (await rows(page))[0], peer = await context.newPage(); await peer.goto("/"); const item = peer.getByTestId("local-recording-" + original.meta.id);
  await expect(item.getByRole("button", { name: "恢复中断片段", exact: true })).toBeDisabled(); await expect(item.getByRole("button", { name: "丢弃片段", exact: true })).toBeDisabled(); await item.getByRole("button", { name: "保留中断副本", exact: true }).click();
  await expect.poll(async () => (await rows(peer)).some(r => r.meta.snapshotOf === original.meta.id)).toBe(true); const copy = (await rows(peer)).find(r => r.meta.snapshotOf === original.meta.id)!;
  await expect.poll(async () => (await rows(peer)).find(r => r.meta.id === original.meta.id)?.bytes ?? 0).toBeGreaterThan(copy.bytes);
  await expect(page.getByTestId("recording-indicator")).toBeVisible(); expect((await rows(peer)).find(r => r.meta.id === original.meta.id)?.meta).toMatchObject({ status: "recording", interrupted: false, activationId: original.meta.activationId, recordingGuard: original.meta.recordingGuard }); expect((await rows(peer)).find(r => r.meta.id === copy.meta.id)).toEqual(copy);
  await fs.writeFile("data/verification/round21-snapshot-live.json", JSON.stringify({ passed: true, actualRecordingContinues: true, growingOriginalUntouched: true, immutableCopy: true, paidCalls: 0 }));
});

test("gapped fragments refuse uploadable copies but raw backup preserves every sequence", async ({ page }) => {
  await login(page, "snapshot-gap"); const id = await create(page), recId = await seed(page, id, "recording", [0, 2]), before = (await rows(page))[0]; await page.getByTestId("local-recording-" + recId).getByRole("button", { name: "保留中断副本", exact: true }).click(); await expect(page.getByText("分片不连续", { exact: false })).toBeVisible(); expect(await rows(page)).toEqual([before]);
  const raw = JSON.parse((await backup(page, recId, "下载原始备份")).toString()); expect(raw.chunks.map((c: { sequence: number }) => c.sequence)).toEqual([0, 2]); expect(raw.chunks.every((c: { base64: string; bytes: number }) => Buffer.from(c.base64, "base64").equals(pcmFixture(6)) && c.bytes === pcmFixture(6).length)).toBe(true);
});

for (const [name, button] of [["play", "回放片段"], ["audio", "下载录音"], ["backup", "下载原始备份"]] as const) test(`account switches during the atomic ${name} read; no audio or download URL is exposed`, async ({ page }) => {
  await login(page, `snapshot-${name}-race`); const id = await create(page), recId = await seed(page, id, "pending");
  await page.evaluate(({ recId, button }) => {
    const native = IDBDatabase.prototype.transaction, w = window as typeof window & { raceArmed: boolean; raceApplied: boolean; unsafeUrls: number }; w.raceArmed = true; w.raceApplied = false; w.unsafeUrls = 0;
    const make = URL.createObjectURL.bind(URL); URL.createObjectURL = blob => { if (blob instanceof Blob && ["audio/wav", "application/json"].includes(blob.type)) w.unsafeUrls++; return make(blob); };
    IDBDatabase.prototype.transaction = function (stores, mode, options) {
      const tx = native.call(this, stores, mode, options), names = typeof stores === "string" ? [stores] : Array.from(stores);
      if (w.raceArmed && mode === "readonly" && names.includes("privateSession") && names.includes("recordings") && names.includes("chunks")) { w.raceArmed = false; const db = this; tx.addEventListener("complete", () => {
        const change = native.call(db, ["privateSession", "recordings", "chunks"], "readwrite"), q = change.objectStore("privateSession").get("current"); q.onsuccess = () => { const next = { ...q.result, userId: "synthetic-other-account", epoch: crypto.randomUUID() }; change.objectStore("privateSession").put(next); const m = change.objectStore("recordings").get(recId); m.onsuccess = () => { change.objectStore("recordings").put({ ...m.result, userId: next.userId, localEpoch: next.epoch }); change.objectStore("chunks").put({ recId, seq: 0, blob: new Blob(["OTHER_ACCOUNT_PRIVATE_BYTES"], { type: "audio/wav" }) }); }; }; change.addEventListener("complete", () => { w.raceApplied = true; });
      }, { once: true }); } return tx;
    };
    const item = document.querySelector(`[data-testid="local-recording-${recId}"]`)!; [...item.querySelectorAll("button")].find(b => b.textContent === button)!.click();
  }, { recId, button });
  await expect.poll(() => page.evaluate(() => (window as typeof window & { raceApplied: boolean }).raceApplied)).toBe(true);
  await expect(page.getByText("当前登录已结束，请重新登录。", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => (window as typeof window & { unsafeUrls: number }).unsafeUrls)).toBe(0);
});

test("consent withdrawn while raw backup serializes prevents the download", async ({ page }) => {
  await login(page, "snapshot-consent-race"); const id = await create(page), recId = await seed(page, id, "pending");
  await page.evaluate(recId => {
    const native = Blob.prototype.arrayBuffer, make = URL.createObjectURL.bind(URL), w = window as typeof window & { changed: boolean; unsafeUrls: number }; w.changed = false; w.unsafeUrls = 0;
    URL.createObjectURL = blob => { if (blob instanceof Blob && blob.type === "application/json") w.unsafeUrls++; return make(blob); };
    Blob.prototype.arrayBuffer = async function () { const bytes = await native.call(this); if (this.type === "audio/wav" && !w.changed) { await new Promise<void>((resolve, reject) => { const r = indexedDB.open("ielts-recordings", 2); r.onsuccess = () => { const db = r.result, tx = db.transaction("privateSession", "readwrite"), q = tx.objectStore("privateSession").get("current"); q.onsuccess = () => tx.objectStore("privateSession").put({ ...q.result, consentAllowed: false, consentVersion: q.result.consentVersion + 1 }); tx.oncomplete = () => { w.changed = true; db.close(); resolve(); }; tx.onerror = () => reject(tx.error); }; }); } return bytes; };
    const item = document.querySelector(`[data-testid="local-recording-${recId}"]`)!; [...item.querySelectorAll("button")].find(b => b.textContent === "下载原始备份")!.click();
  }, recId);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { changed: boolean }).changed)).toBe(true);
  await expect(page.getByText("录音授权已撤回或改变", { exact: false })).toBeVisible(); expect(await page.evaluate(() => (window as typeof window & { unsafeUrls: number }).unsafeUrls)).toBe(0);
});
