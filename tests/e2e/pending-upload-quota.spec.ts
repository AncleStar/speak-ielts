import fs from "node:fs/promises";
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
test.use({ extraHTTPHeaders: {Origin: "http://127.0.0.1:3100",  "x-forwarded-for": "192.0.2.111" } });
type Local = { meta: { id: string; durationMs: number; mimeType: string; status: string }[]; chunks: number; bytes: number; discards: number };
let owned: string[] = [];
test.beforeEach(() => { owned = []; });
test.afterEach(async ({ context }) => { for (const id of owned) { const r = await context.request.delete(`/api/sessions/${id}`); expect([200, 404]).toContain(r.status()); } });
async function local(page: Page): Promise<Local> {
  return page.evaluate(() => new Promise<Local>((resolve, reject) => {
    const r = indexedDB.open("ielts-recordings", 2); r.onerror = () => reject(r.error); r.onsuccess = () => { const db = r.result, tx = db.transaction(["recordings", "chunks", "privateSession"]), meta = tx.objectStore("recordings").getAll(), chunks = tx.objectStore("chunks").getAll(), rows = tx.objectStore("privateSession").getAll(); tx.oncomplete = () => { resolve({ meta: meta.result, chunks: chunks.result.length, bytes: chunks.result.reduce((sum, row) => sum + row.blob.size, 0), discards: rows.result.filter(row => row.kind === "upload-discard").length }); db.close(); }; tx.onerror = () => reject(tx.error); };
  }));
}
async function me(page: Page) { const r = await page.request.get("/api/me"); expect(r.ok()).toBe(true); return r.json(); }
async function fragment(page: Page, context: BrowserContext, account: string) {
  await page.goto("/login"); await page.getByLabel("邮箱", { exact: true }).fill(`${account}@example.test`); await page.getByLabel("密码", { exact: true }).fill("Browser-test-123!"); await page.getByRole("button", { name: "登录", exact: true }).click(); await expect(page).not.toHaveURL(/\/login$/);
  const created = await page.request.post("/api/sessions", { data: { mode: "practice", questionId: "P2-PERSON-1", fresh: true } }); expect(created.ok()).toBe(true); const { id } = await created.json(); owned.push(id);
  await page.goto(`/interview/${id}`); await page.getByTestId("start-interview").click(); await page.getByRole("button", { name: "开始回答", exact: true }).click(); await expect(page.getByTestId("recording-indicator")).toBeVisible(); await expect.poll(async () => (await local(page)).chunks).toBeGreaterThanOrEqual(4);
  const before = await local(page); expect(before.bytes).toBeGreaterThan(1000); const nonce = before.meta[0].id;
  const crashed = page.waitForEvent("crash"), cdp = await context.newCDPSession(page); void cdp.send("Page.crash").catch(() => {}); await crashed; await page.close();
  const reopened = await context.newPage(), view = await (await reopened.request.get(`/api/sessions/${id}`)).json(), identity = await me(reopened);
  const pause = await reopened.request.post(`/api/sessions/${id}/events`, { data: { type: "pause", eventId: crypto.randomUUID(), expectedVersion: view.session.stateVersion, startEventId: view.session.activationId, pendingUploads: [{ submissionId: nonce, planIndex: 0, kind: "main", consentVersion: identity.user.recordingConsentVersion }] } }); expect(pause.ok()).toBe(true);
  const r = await reopened.request.post("/api/answers/upload-ticket", { data: { sessionId: id, submissionId: nonce, planIndex: 0, kind: "main", interrupted: true, clientDurationMs: before.meta[0].durationMs, consentVersion: identity.user.recordingConsentVersion } }); expect(r.ok()).toBe(true); const ticket = await r.json();
  await reopened.goto(`/interview/${id}`); await expect(reopened.getByRole("button", { name: "恢复中断片段", exact: true })).toBeEnabled();
  const pending = await me(reopened); expect(pending.quota.pendingUploadSeconds).toBe(Math.ceil(before.meta[0].durationMs / 1000)); expect(pending.quota.reservedSeconds).toBe(0); expect(pending.quota.warn).toBe(false);
  return { page: reopened, id, nonce, before, ticket, pending };
}
test("offline discard is durable across page close and reconnect cancels only its server reservation", async ({ page, context }) => {
  const f = await fragment(page, context, "pending-discard"), p = f.page;
  await p.getByRole("button", { name: "恢复中断片段", exact: true }).click(); await expect(p.locator("audio")).toBeVisible();
  await context.setOffline(true); p.once("dialog", d => d.accept()); await p.getByRole("button", { name: "丢弃片段", exact: true }).click();
  await expect(p.getByText("本机片段已丢弃，取消任务已保留。上传暂记尚未确认释放，联网后自动同步。", { exact: true })).toBeVisible(); expect(await local(p)).toMatchObject({ chunks: 0, bytes: 0, discards: 1 }); await expect(p.locator("audio")).toHaveCount(0);
  await p.close(); await context.setOffline(false); const next = await context.newPage(); await next.goto("/");
  await expect.poll(async () => (await local(next)).discards).toBe(0); expect((await me(next)).quota).toMatchObject({ extraSeconds: 60, pendingUploadSeconds: 0, warn: false });
  await expect(next.getByTestId("pending-upload-quota")).toHaveCount(0); await expect(next.getByText("今日额度已使用 80% 以上", { exact: false })).toHaveCount(0);
  expect((await next.request.put(f.ticket.uploadUrl, { headers: { "Content-Type": "audio/webm" }, data: Buffer.from([1, 2, 3]) })).status()).toBe(410);
  const view = await (await next.request.get(`/api/sessions/${f.id}`)).json(); expect(view.session.status).toBe("paused"); expect(view.answers[0]).toMatchObject({ interrupted: true, status: "failed" });
  const history = await (await next.request.get("/api/sessions")).json(); expect(history.sessions.find((row: { id: string }) => row.id === f.id)).toMatchObject({ durationMs: 0, answerCount: 0 });
  await next.waitForTimeout(4500); await next.screenshot({ path: "data/verification/round12-home-desktop.png", fullPage: true }); await next.setViewportSize({ width: 320, height: 740 });
  const titleWidth = await next.getByTestId("recent-record-title").first().evaluate(e => e.getBoundingClientRect().width); expect(titleWidth).toBeGreaterThan(160);
  await next.screenshot({ path: "data/verification/round12-home-320.png", fullPage: true }); expect(await next.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await next.goto(`/sessions/${f.id}`); await expect(next.getByTestId("report-status")).toHaveAttribute("data-state", "empty"); await expect(next.getByText("已丢弃 1 个片段，尚无已上传回答", { exact: true })).toBeVisible();
  const card = next.getByTestId("answer-card"); await expect(card).toHaveAttribute("data-status", "discarded"); await expect(card.getByRole("button", { name: "重试处理", exact: true })).toHaveCount(0); await expect(card.locator("audio")).toHaveCount(0); await expect(next.getByText("已保存回答已处理", { exact: false })).toHaveCount(0);
  await next.screenshot({ path: "data/verification/round12-discard-report-320.png", fullPage: true }); expect(await next.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await next.setViewportSize({ width: 1440, height: 1000 }); await next.screenshot({ path: "data/verification/round12-discard-report-desktop.png", fullPage: true });
  await next.goto(`/answers/${f.ticket.answerId}`); await expect(next.getByTestId("answer-card")).toHaveAttribute("data-status", "discarded"); await next.getByRole("tab", { name: "反馈报告", exact: true }).click(); await expect(next.getByText("这次片段已丢弃，没有上传录音，不会生成反馈。重新作答后可查看新的报告。", { exact: true })).toBeVisible(); await expect(next.getByRole("button", { name: "我已复盘，准备重练", exact: true })).toHaveCount(0);
  await next.getByRole("tab", { name: "录音与转写", exact: true }).click(); await next.getByTestId("resume-discarded").click(); await expect(next).toHaveURL(new RegExp(`/interview/${f.id}$`)); await next.getByTestId("start-interview").click(); await expect(next.getByTestId("exit-interview")).toBeVisible(); await expect.poll(async () => (await me(next)).quota.reservedSeconds).toBeGreaterThan(0);
  await next.getByTestId("exit-interview").click(); await expect(next).toHaveURL(/\/practice\?.*disc=P2-PERSON-1/);
  await fs.writeFile("data/verification/round12-discard-browser.json", JSON.stringify({ actualMediaRecorder: true, rendererCrash: true, durableChunks: f.before.chunks, savedBytes: f.before.bytes, offlineDiscardOutbox: true, closedPageThenReconnected: true, releasedSeconds: f.pending.quota.pendingUploadSeconds, unuploadedHistorySeconds: 0, latePutStatus: 410, discardedReportState: "empty", originalSessionResume: true, reservationReadmitted: true, misleadingRetryHidden: true, homeTitleWidthAt320: titleWidth, completed: false, paidApiCalls: 0 }, null, 2));
});
test("discarding a local copy after its audio arrived preserves the server recording and consumed time", async ({ page, context }) => {
  const f = await fragment(page, context, "pending-stored"), p = f.page;
  const bytes = await p.evaluate(() => new Promise<number[]>((resolve, reject) => { const r = indexedDB.open("ielts-recordings", 2); r.onsuccess = () => { const db = r.result, tx = db.transaction("chunks"), get = tx.objectStore("chunks").getAll(); get.onsuccess = () => { const rows = get.result.sort((a, b) => a.seq - b.seq); void new Blob(rows.map(row => row.blob)).arrayBuffer().then(buf => resolve([...new Uint8Array(buf)])); }; tx.oncomplete = () => db.close(); tx.onerror = () => reject(tx.error); }; }));
  expect((await p.request.put(f.ticket.uploadUrl, { headers: { "Content-Type": f.before.meta[0].mimeType }, data: Buffer.from(bytes) })).ok()).toBe(true);
  expect((await p.request.post(`/api/answers/${f.ticket.answerId}/submit`)).ok()).toBe(true); await expect.poll(async () => (await (await p.request.get(`/api/answers/${f.ticket.answerId}`)).json()).answer.status).toBe("done");
  const before = (await me(p)).quota; expect(before.pendingUploadSeconds).toBe(0); expect(before.extraSeconds).toBeLessThan(60);
  p.once("dialog", d => d.accept()); await p.getByRole("button", { name: "丢弃片段", exact: true }).click(); await expect(p.getByText("本机片段已丢弃；服务器已保存的记录与已消费时长仍保留。", { exact: true })).toBeVisible(); expect((await local(p)).bytes).toBe(0);
  expect((await me(p)).quota.extraSeconds).toBe(before.extraSeconds); const detail = await (await p.request.get(`/api/answers/${f.ticket.answerId}`)).json(); expect(detail.answer).toMatchObject({ status: "done", interrupted: true }); expect(detail.answer.durationMs).toBeGreaterThan(0); expect((await p.request.get(`/api/answers/${f.ticket.answerId}/audio`)).ok()).toBe(true);
});
test("a real IndexedDB transaction failure keeps the recording rather than half discarding it", async ({ page, context }) => {
  const f = await fragment(page, context, "pending-storage"), p = f.page;
  await p.evaluate(() => { const put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) { if ((value as { kind?: string })?.kind === "upload-discard") this.transaction.abort(); return key === undefined ? put.call(this, value) : put.call(this, value, key); }; });
  p.once("dialog", d => d.accept()); await p.getByRole("button", { name: "丢弃片段", exact: true }).click(); await expect(p.getByText("无法保存取消任务，片段仍保留。请检查浏览器存储后重试。", { exact: true })).toBeVisible(); expect(await local(p)).toMatchObject({ bytes: f.before.bytes, chunks: f.before.chunks, discards: 0 }); expect((await me(p)).quota.extraSeconds).toBe(f.pending.quota.extraSeconds);
});
test("an interrupted mock's discarded answer offers a fresh exact-question recording rather than exam resume", async ({ page }) => {
  await page.goto("/login"); await page.getByLabel("邮箱", { exact: true }).fill("discarded-mock@example.test"); await page.getByLabel("密码", { exact: true }).fill("Browser-test-123!"); await page.getByRole("button", { name: "登录", exact: true }).click(); await expect(page).not.toHaveURL(/\/login$/);
  const created = await page.request.post("/api/sessions", { data: { mode: "mock", mockSetId: "mock-1", fresh: true } }); expect(created.ok()).toBe(true); const { id } = await created.json(); owned.push(id);
  const activationId = crypto.randomUUID(); expect((await page.request.post(`/api/sessions/${id}/events`, { data: { type: "start", eventId: activationId, expectedVersion: 0 } })).ok()).toBe(true);
  const identity = await me(page), submissionId = crypto.randomUUID();
  expect((await page.request.post(`/api/sessions/${id}/events`, { data: { type: "pause", eventId: crypto.randomUUID(), expectedVersion: 1, startEventId: activationId, pendingUploads: [{ submissionId, planIndex: 0, kind: "main", consentVersion: identity.user.recordingConsentVersion }] } })).ok()).toBe(true);
  const declared = await page.request.post("/api/answers/upload-ticket", { data: { sessionId: id, submissionId, planIndex: 0, kind: "main", clientDurationMs: 1001, consentVersion: identity.user.recordingConsentVersion } }); expect(declared.ok()).toBe(true); const { answerId } = await declared.json();
  expect((await page.request.post("/api/answers/discard-pending", { data: { sessionId: id, submissionId } })).ok()).toBe(true);
  const original = await (await page.request.get(`/api/sessions/${id}`)).json(); expect(original.session.status).toBe("interrupted");
  await page.goto(`/sessions/${id}`); await expect(page.getByTestId("report-status")).toHaveAttribute("data-state", "empty"); await expect(page.getByTestId("continue-session")).toHaveCount(0); await expect(page.getByTestId("resume-discarded")).toHaveCount(0);
  await page.goto(`/answers/${answerId}`); await expect(page.getByTestId("answer-card")).toHaveAttribute("data-status", "discarded"); await expect(page.getByTestId("resume-discarded")).toHaveCount(0);
  const response = page.waitForResponse(r => r.url().endsWith("/api/sessions") && r.request().method() === "POST"); await page.getByTestId("rerecord-discarded").click(); const r = await response; expect(r.ok()).toBe(true); const retried = await r.json(); owned.push(retried.id); await expect(page).toHaveURL(new RegExp(`/interview/${retried.id}$`));
  const fresh = await (await page.request.get(`/api/sessions/${retried.id}`)).json(); expect(fresh.plan.mode).toBe("retry"); expect(fresh.plan.items[0].prompt.text).toBe(original.plan.items[0].prompt.text); expect((await (await page.request.get(`/api/sessions/${id}`)).json()).session.status).toBe("interrupted");
});
