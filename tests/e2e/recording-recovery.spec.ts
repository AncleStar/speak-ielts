import fs from "node:fs/promises";
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import pg from "pg";

test.use({ extraHTTPHeaders: { "x-forwarded-for": "192.0.2.102" }, viewport: { width: 1440, height: 1000 } });
type Local = { meta: { id: string; status: string; durationMs: number; interrupted: boolean; recordingGuard?: string }[]; chunks: number; bytes: number };
let ownedSession: string | null = null;
test.beforeEach(() => { ownedSession = null; });
test.afterEach(async ({ context }) => {
  // A failed crash fixture must not consume site-wide capacity for unrelated tests.
  if (ownedSession) { const response = await context.request.delete(`/api/sessions/${ownedSession}`); expect([200, 404]).toContain(response.status()); }
});
async function local(page: Page): Promise<Local> {
  return page.evaluate(() => new Promise<Local>((resolve, reject) => {
    const request = indexedDB.open("ielts-recordings", 2); request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction(["recordings", "chunks"]), meta = tx.objectStore("recordings").getAll(), chunks = tx.objectStore("chunks").getAll();
      tx.oncomplete = () => { resolve({ meta: meta.result.map(row => ({ id: row.id, status: row.status, durationMs: row.durationMs, interrupted: row.interrupted, recordingGuard: row.recordingGuard })), chunks: chunks.result.length, bytes: chunks.result.reduce((sum, row) => sum + row.blob.size, 0) }); db.close(); };
      tx.onerror = () => reject(tx.error);
    };
  }));
}
async function login(page: Page, name: string) {
  await page.goto("/login"); await page.getByLabel("邮箱", { exact: true }).fill(`${name}@example.test`); await page.getByLabel("密码", { exact: true }).fill("Browser-test-123!"); await page.getByRole("button", { name: "登录", exact: true }).click(); await expect(page).not.toHaveURL(/\/login$/);
}
async function record(page: Page, mock = false) {
  const response = await page.request.post("/api/sessions", { data: mock ? { mode: "mock", mockSetId: "mock-1", fresh: true } : { mode: "practice", questionId: "P2-PERSON-1", fresh: true } }); expect(response.ok()).toBe(true); const { id } = await response.json();
  ownedSession = id;
  await page.goto(`/interview/${id}`); await page.getByTestId("start-interview").click(); if (!mock) await page.getByRole("button", { name: "开始回答", exact: true }).click(); await expect(page.getByTestId("recording-indicator")).toBeVisible();
  await expect.poll(async () => (await local(page)).chunks).toBeGreaterThanOrEqual(mock ? 1 : 4);
  return id as string;
}
async function crash(page: Page, context: BrowserContext) {
  const before = await local(page); expect(before.meta[0]).toMatchObject({ status: "recording", interrupted: false, recordingGuard: "web-lock-v1" });
  const event = page.waitForEvent("crash"), cdp = await context.newCDPSession(page); void cdp.send("Page.crash").catch(() => {}); await event; await page.close(); return before;
}
async function ready(page: Page, id: string) { await page.goto(`/interview/${id}`); await expect(page.getByTestId("ready-panel")).toBeVisible(); await expect(page.getByRole("button", { name: "恢复中断片段", exact: true })).toBeEnabled(); }
async function saved(page: Page, id: string) {
  await expect.poll(async () => {
    const view = await (await page.request.get(`/api/sessions/${id}`)).json();
    const row = view.answers.find((a: { id: string; status: string; interrupted: boolean }) => a.status === "done" && a.interrupted);
    if (!row) return false;
    // Decoded metrics are available from the answer-detail API, not the session's compact answer list.
    const detail = await (await page.request.get(`/api/answers/${row.id}`)).json();
    return detail.answer.interrupted && detail.answer.metrics?.durationSec > 0 && detail.answer.durationMs > 0;
  }, { timeout: 30000 }).toBe(true);
}

test("crashed real recording recovers offline, plays saved chunks and uploads without completing the question", async ({ page, context }) => {
  await login(page, "recover-crash"); await page.goto("/practice?part=2&disc=P2-PERSON-1"); const id = await record(page), before = await crash(page, context), reopened = await context.newPage();
  await ready(reopened, id); expect((await local(reopened)).bytes).toBe(before.bytes); await expect(reopened.getByTestId("start-interview")).toBeDisabled();
  await context.setOffline(true); await reopened.getByRole("button", { name: "恢复中断片段", exact: true }).click();
  await expect(reopened.getByText("已恢复为中断片段，不计为完整作答。", { exact: true })).toBeVisible(); expect((await local(reopened)).meta[0]).toMatchObject({ status: "pending", interrupted: true });
  const audio = reopened.locator('audio[aria-label="本机中断录音回放"]'); await expect(audio).toBeVisible(); await audio.evaluate((element: HTMLAudioElement) => element.play());
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.ended), { timeout: 10000 }).toBe(true);
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(3);
  await reopened.getByRole("button", { name: "重试上传", exact: true }).click(); await expect(reopened.getByText("当前离线，录音保留在本机", { exact: false })).toBeVisible(); expect((await local(reopened)).bytes).toBe(before.bytes);
  await expect(reopened.getByTestId("disc-scene")).toHaveAttribute("data-renderer", "ready"); await reopened.waitForTimeout(4500); await reopened.screenshot({ path: "data/verification/round10-recovered-desktop.png", fullPage: true });
  await reopened.setViewportSize({ width: 320, height: 740 }); await reopened.screenshot({ path: "data/verification/round10-recovered-320.png", fullPage: true }); expect(await reopened.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await context.setOffline(false); await reopened.getByRole("button", { name: "重试上传", exact: true }).click(); await expect(reopened.getByText("上传成功，反馈将在后台生成。", { exact: true })).toBeVisible(); await saved(reopened, id); expect((await local(reopened)).chunks).toBe(0);
  const finish = await reopened.request.post(`/api/sessions/${id}/events`, { data: { type: "finish", eventId: crypto.randomUUID() } }); expect(finish.ok()).toBe(true); expect((await finish.json()).status).toBe("active");
  await reopened.getByTestId("start-interview").click(); await reopened.getByRole("button", { name: "开始回答", exact: true }).click(); await expect(reopened.getByTestId("recording-indicator")).toBeVisible(); await reopened.getByTestId("exit-interview").click(); await expect(reopened).toHaveURL(/disc=P2-PERSON-1/);
  await fs.writeFile("data/verification/round10-crash-browser.json", JSON.stringify({ actualMediaRecorder: true, rendererCrash: true, durableChunks: before.chunks, bytesPreserved: before.bytes, offlineRecovery: true, actualBrowserPlaybackEnded: true, serverDecodedInterrupted: true, completed: false, paidApiCalls: 0 }, null, 2));
});

test("an old live recorder cannot be recovered; after its crash two recovery pages finalize once and observe deletion", async ({ page, context }) => {
  await login(page, "recover-peer"); const id = await record(page);
  await page.evaluate(() => new Promise<void>((resolve, reject) => { const request = indexedDB.open("ielts-recordings", 2); request.onsuccess = () => { const db = request.result, tx = db.transaction("recordings", "readwrite"), cursor = tx.objectStore("recordings").openCursor(); cursor.onsuccess = () => { if (cursor.result) cursor.result.update({ ...cursor.result.value, createdAt: Date.now() - 11 * 60000 }); }; tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); }; }));
  const peer = await context.newPage(); await peer.goto("/"); await expect(peer.getByText("另一页面正在录音或保存，此处不能恢复或丢弃。", { exact: true })).toBeVisible(); await expect(peer.getByRole("button", { name: "恢复中断片段", exact: true })).toBeDisabled(); await expect(peer.getByRole("button", { name: "丢弃片段", exact: true })).toBeDisabled();
  const before = await crash(page, context); await expect(peer.getByRole("button", { name: "恢复中断片段", exact: true })).toBeEnabled(); const twin = await context.newPage(); await twin.goto("/"); await expect(twin.getByRole("button", { name: "恢复中断片段", exact: true })).toBeEnabled();
  await Promise.all([peer.getByRole("button", { name: "恢复中断片段", exact: true }).click(), twin.getByRole("button", { name: "恢复中断片段", exact: true }).click()]);
  await expect.poll(async () => (await local(peer)).meta[0].interrupted).toBe(true); expect((await local(peer)).bytes).toBe(before.bytes);
  await expect(peer.getByRole("button", { name: "回放片段", exact: true })).toBeVisible(); await expect(twin.getByRole("button", { name: "回放片段", exact: true })).toBeVisible();
  peer.once("dialog", dialog => dialog.accept()); await peer.getByRole("button", { name: "丢弃片段", exact: true }).click(); await expect.poll(async () => (await local(twin)).chunks).toBe(0); await expect(twin.getByRole("button", { name: "回放片段", exact: true })).toHaveCount(0); await expect(twin.locator("audio")).toHaveCount(0);
  expect((await peer.request.delete(`/api/sessions/${id}`)).ok()).toBe(true); await twin.close(); await peer.close();
});

test("an inactive ordinary practice prepares a guarded retained upload then resumes its original question", async ({ page, context }) => {
  await login(page, "recover-inactive"); const id = await record(page); await crash(page, context);
  // Only the fresh isolated test database is used; reproduce the hourly maintenance state without waiting 30 minutes.
  const pool = new pg.Pool({ connectionString: "postgres://postgres:postgres@127.0.0.1:5545/e2e" }); try { await pool.query("update practice_session set status='abandoned', interrupt_reason='inactive', ended_at=now(), state_version=state_version+1, last_activity_at=now()-interval '31 minutes' where id=$1", [id]); } finally { await pool.end(); }
  const reopened = await context.newPage(); await ready(reopened, id); await reopened.getByRole("button", { name: "恢复中断片段", exact: true }).click(); await reopened.getByRole("button", { name: "重试上传", exact: true }).click(); await expect(reopened.getByText("上传成功，反馈将在后台生成。", { exact: true })).toBeVisible(); await saved(reopened, id);
  const paused = await (await reopened.request.get(`/api/sessions/${id}`)).json(); expect(paused.session.status).toBe("paused"); expect((await (await reopened.request.get("/api/me")).json()).quota.reservedSeconds).toBe(0);
  await reopened.getByTestId("start-interview").click(); await reopened.getByRole("button", { name: "开始回答", exact: true }).click(); await expect(reopened.getByTestId("recording-indicator")).toBeVisible(); await reopened.getByTestId("exit-interview").click(); await expect(reopened).toHaveURL(/\/practice/);
});

test("a crashed mock saves recovered fragments while the mock remains interrupted", async ({ page, context }) => {
  await login(page, "recover-mock"); const id = await record(page, true); await crash(page, context); const reopened = await context.newPage(); await reopened.goto(`/interview/${id}`); await expect(reopened.getByRole("button", { name: "恢复中断片段", exact: true })).toBeEnabled();
  await reopened.getByRole("button", { name: "恢复中断片段", exact: true }).click(); await reopened.getByRole("button", { name: "重试上传", exact: true }).click(); await expect(reopened.getByText("上传成功，反馈将在后台生成。", { exact: true })).toBeVisible(); await saved(reopened, id);
  const view = await (await reopened.request.get(`/api/sessions/${id}`)).json(); expect(view.session.status).toBe("interrupted"); expect((await (await reopened.request.get("/api/me")).json()).quota.reservedSeconds).toBe(0); await expect(reopened.getByTestId("start-interview")).toHaveCount(0);
});

test("withdrawing consent removes the recovered preview and retained chunks in every page", async ({ page, context }) => {
  await login(page, "recover-consent"); const id = await record(page); await crash(page, context); const reopened = await context.newPage(); await ready(reopened, id); await reopened.getByRole("button", { name: "恢复中断片段", exact: true }).click(); await expect(reopened.locator("audio")).toBeVisible();
  const settings = await context.newPage(); await settings.goto("/settings"); settings.once("dialog", dialog => dialog.accept()); await settings.getByRole("button", { name: "撤回录音同意", exact: true }).click(); await expect(settings).toHaveURL(/consent=withdrawn/);
  await expect(reopened.locator("audio")).toHaveCount(0); await expect.poll(async () => (await local(settings)).chunks).toBe(0); await expect(reopened.getByRole("button", { name: "重试上传", exact: true })).toHaveCount(0); await settings.close();
});
