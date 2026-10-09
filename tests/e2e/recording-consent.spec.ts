import fs from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
test.use({ reducedMotion: "reduce", extraHTTPHeaders: { "x-forwarded-for": "192.0.2.96" } });
const origin = { Origin: "http://127.0.0.1:3100" };
async function login(page: Page, name: string) {
  await page.goto("/login"); await page.getByLabel("邮箱", { exact: true }).fill(`${name}@example.test`); await page.getByLabel("密码", { exact: true }).fill("Browser-test-123!");
  await page.getByRole("button", { name: "登录", exact: true }).click(); await expect(page).not.toHaveURL(/login/);
}
async function withdraw(page: Page) {
  await page.goto("/settings"); page.once("dialog", dialog => dialog.accept()); await page.getByRole("button", { name: "撤回录音同意", exact: true }).click();
  await expect(page).toHaveURL(/settings\?consent=withdrawn/); await expect(page.getByText("你尚未同意录音说明，暂时不能录音练习。", { exact: true })).toBeVisible();
}
async function counts(page: Page) {
  return page.evaluate(() => new Promise<number[]>((resolve, reject) => {
    const request = indexedDB.open("ielts-recordings", 2); request.onerror = () => reject(request.error);
    request.onsuccess = () => { const db = request.result, names = ["recordings", "chunks", "thoughtDrafts"], tx = db.transaction(names), out: number[] = [];
      names.forEach((name, i) => { const r = tx.objectStore(name).count(); r.onsuccess = () => { out[i] = r.result; }; }); tx.oncomplete = () => { db.close(); resolve(out); }; };
  }));
}
async function observeTracks(page: Page) {
  let ended = false; await page.exposeFunction("reportConsentStopped", () => { ended = true; });
  await page.addInitScript(() => {
    const w = window as typeof window & { consentTracks: MediaStreamTrack[]; reportConsentStopped: () => Promise<void> }; w.consentTracks = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = async c => { const stream = await original(c); w.consentTracks.push(...stream.getTracks()); return stream; };
    const stop = MediaStreamTrack.prototype.stop; MediaStreamTrack.prototype.stop = function() { stop.call(this); if (w.consentTracks.length && w.consentTracks.every(t => t.readyState === "ended")) void w.reportConsentStopped().catch(() => {}); };
  }); return () => ended;
}
test("withdrawal stops another tab's interview despite a hanging identity check, rejects old tickets and preserves text drafts", async ({ page, context }) => {
  const stopped = await observeTracks(page); await login(page, "consent-interview");
  await page.goto("/thoughts"); await page.getByLabel("原始观点（中文或英文）").fill("A draft retained when recording consent is withdrawn."); await expect(page.getByText("草稿已在本机暂存 · 保留 24 小时", { exact: true })).toBeVisible();
  const me = await (await page.request.get("/api/me")).json();
  const created = await page.request.post("/api/sessions", { data: { mode: "practice", questionId: "P2-PERSON-1", fresh: true } }); expect(created.ok()).toBe(true); const { id } = await created.json();
  const ticket = await (await page.request.post("/api/answers/upload-ticket", { data: { sessionId: id, planIndex: 0, kind: "main", submissionId: crypto.randomUUID(), clientDurationMs: 500 } })).json();
  page.once("dialog", dialog => dialog.accept()); await page.goto(`/interview/${id}`); await page.getByRole("button", { name: "开始面试", exact: true }).click(); await page.getByRole("button", { name: "开始回答", exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.recording)).toBe("true");
  let release!: () => void, checking = false; const gate = new Promise<void>(r => { release = r; });
  await page.route("**/api/me", async route => { checking = true; await gate; await route.continue().catch(() => {}); });
  await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await expect.poll(() => checking).toBe(true);
  const other = await context.newPage(); try { await withdraw(other); await expect.poll(stopped, { timeout: 5000 }).toBe(true); } finally { release(); }
  await expect(page.getByText("录音授权已改变，面试已停止", { exact: true })).toBeVisible(); expect((await page.request.get("/api/me")).status()).toBe(200);
  const after = await (await page.request.get("/api/me")).json(); expect(after.user.id).toBe(me.user.id); expect(after.user.consentAt).toBeNull();
  await expect.poll(() => counts(page)).toEqual([0, 0, 1]); const { pcmFixture } = await import("../../scripts/make-fixtures");
  expect((await page.request.put(ticket.uploadUrl, { headers: { ...origin, "Content-Type": "audio/wav" }, data: pcmFixture(0.5) })).status()).toBe(403);
  expect((await page.request.post(`/api/answers/${ticket.answerId}/submit`, { headers: origin })).status()).toBe(403);
  const view = await (await page.request.get(`/api/sessions/${id}`)).json(); expect(view.session.status).toBe("abandoned"); expect(view.session.interruptReason).toBe("consent_withdrawn");
  await fs.mkdir("data/verification", { recursive: true }); await page.screenshot({ path: "data/verification/round4-consent-interview.png", fullPage: true });
  const report = await context.newPage(); await report.goto(`/answers/${ticket.answerId}`); await expect(report.getByText("等待重新授权", { exact: true }).first()).toBeVisible(); await expect(report.getByRole("link", { name: "前往设置重新同意", exact: true })).toBeVisible(); await expect(report.getByRole("button", { name: "重试处理", exact: true })).toHaveCount(0);
  await report.setViewportSize({ width: 320, height: 780 }); await expect(report.getByRole("link", { name: "前往设置重新同意", exact: true })).toBeVisible(); expect(await report.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await report.screenshot({ path: "data/verification/round4-consent-report-mobile.png", fullPage: true }); await report.close();
  await page.getByTestId("exit-interview").click(); await expect(page).toHaveURL(/practice/); await page.goto("/thoughts"); await page.getByRole("button", { name: "恢复草稿", exact: true }).first().click();
  await expect(page.getByLabel("原始观点（中文或英文）")).toHaveValue("A draft retained when recording consent is withdrawn.");
  // Re-consenting restores new recording, never the old ticket or the old local audio.
  await other.getByRole("link", { name: "前往同意", exact: true }).click(); await expect(other).toHaveURL(/onboarding$/); await other.getByRole("checkbox", { name: /我已阅读并同意上述录音/ }).check(); await other.getByRole("button", { name: "保存并检查麦克风", exact: true }).click(); await expect(other).toHaveURL(/device-check/);
  expect((await other.request.put(ticket.uploadUrl, { headers: { ...origin, "Content-Type": "audio/wav" }, data: pcmFixture(0.5) })).status()).toBe(403);
  await other.getByTestId("mic-connect").click(); await expect(other.getByText("麦克风已连接。对着麦克风说话，音量条应随声音跳动。", { exact: true })).toBeVisible();
});
test("withdrawal releases thought audio but keeps unsaved recall text and the login", async ({ page, context }) => {
  const stopped = await observeTracks(page); await login(page, "consent-thought");
  const thought = await (await page.request.post("/api/thoughts", { headers: origin, data: { sourceText: "Learning through experience helps students.", requestId: crypto.randomUUID() } })).json();
  await page.goto(`/thoughts?thought=${thought.id}`); await page.getByRole("button", { name: "隐藏 Natural，开始练习", exact: true }).click();
  await page.getByLabel("我的尝试表达（可选，也可直接写下来练习）").fill("My text must survive withdrawal."); await expect(page.getByText("草稿已在本机暂存 · 保留 24 小时", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "开始录音", exact: true }).click(); await expect(page.getByRole("button", { name: "结束录音", exact: true })).toBeVisible();
  const other = await context.newPage(); await withdraw(other); await expect.poll(stopped).toBe(true);
  await expect(page.getByRole("button", { name: "开始录音", exact: true })).toBeDisabled(); await expect(page.getByLabel("本次观点练习录音")).toHaveCount(0);
  await expect(page.getByLabel("我的尝试表达（可选，也可直接写下来练习）")).toHaveValue("My text must survive withdrawal.");
  await page.getByRole("button", { name: "保存本次练习", exact: true }).click(); await expect(page.getByText(/练习已保存/)).toBeVisible();
  const detail = await (await page.request.get(`/api/thoughts/${thought.id}`)).json(); expect(detail.practices[0].durationSeconds).toBe(0); expect(detail.practices[0].recalledText).toBe("My text must survive withdrawal.");
});
test("withdrawal closes device-test tracks without recreating its replay URL", async ({ page, context }) => {
  const stopped = await observeTracks(page); await login(page, "consent-device"); await page.goto("/device-check"); await page.getByTestId("mic-connect").click(); await expect(page.getByTestId("mic-test")).toBeVisible();
  await page.getByTestId("mic-test").click(); const other = await context.newPage(); await withdraw(other); await expect.poll(stopped).toBe(true);
  await expect(page.getByText(/录音授权或登录状态已改变，麦克风已关闭/)).toBeVisible(); await expect(page.getByTestId("mic-test-audio")).toHaveCount(0);
  await expect(page.getByTestId("device-continue")).toBeDisabled(); await page.getByTestId("mic-connect").click(); await expect(page.getByText("请先在设置中同意录音授权。", { exact: true })).toBeVisible();
});
test("withdrawal while microphone permission is pending disposes the eventual stream", async ({ page, context }) => {
  const stopped = await observeTracks(page); await login(page, "consent-pending-mic"); await page.goto("/device-check");
  await page.evaluate(() => {
    const w = window as typeof window & { releaseConsentMic: () => void }; let release!: () => void;
    const gate = new Promise<void>(r => { release = r; }), getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    w.releaseConsentMic = release; navigator.mediaDevices.getUserMedia = async c => { await gate; return getMedia(c); };
  });
  await page.getByTestId("mic-connect").click(); await expect(page.getByText("正在请求权限…", { exact: true })).toBeVisible();
  const other = await context.newPage(); await withdraw(other); await page.evaluate(() => (window as typeof window & { releaseConsentMic: () => void }).releaseConsentMic());
  await expect.poll(stopped).toBe(true); await expect(page.getByTestId("device-continue")).toBeDisabled(); await expect(page.getByTestId("mic-test")).toHaveCount(0);
});
test("withdrawal cancels an in-flight upload and never submits it or recreates local chunks", async ({ page, context }) => {
  await login(page, "consent-upload"); await page.goto("/"); await expect(page.getByRole("heading", { name: /你好，consent-upload/ })).toBeVisible(); const me = await (await page.request.get("/api/me")).json();
  const created = await page.request.post("/api/sessions", { data: { mode: "practice", questionId: "P1-HOME-1", fresh: true } }); expect(created.ok()).toBe(true); const { id } = await created.json();
  await page.evaluate(async ({ userId, version, sessionId }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("ielts-recordings", 2); request.onerror = () => reject(request.error);
    request.onsuccess = () => { const db = request.result, tx = db.transaction(["recordings", "chunks", "privateSession"], "readwrite"), scope = tx.objectStore("privateSession").get("current");
      scope.onsuccess = () => { tx.objectStore("recordings").put({ id: "consent-flight-fixture", userId, localEpoch: scope.result.epoch, consentVersion: version, sessionId, promptText: "synthetic pending consent check", status: "failed", createdAt: Date.now(), durationMs: 500, mimeType: "audio/wav", planIndex: 0, kind: "main", followUpId: null, interrupted: false }); tx.objectStore("chunks").put({ recId: "consent-flight-fixture", seq: 0, blob: new Blob(["synthetic-only"], { type: "audio/wav" }) }); };
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
    };
  }), { userId: me.user.id, version: me.user.recordingConsentVersion, sessionId: id });
  await page.reload(); let release!: () => void, started = false, submits = 0; const gate = new Promise<void>(r => { release = r; });
  await page.route("**/api/answers/*/audio?*", async route => { started = true; await gate; await route.continue().catch(() => {}); });
  page.on("request", request => { if (request.url().endsWith("/submit")) submits++; }); await page.getByRole("button", { name: "重试上传", exact: true }).click(); await expect.poll(() => started).toBe(true);
  const other = await context.newPage(); try { await withdraw(other); await expect.poll(() => counts(other)).toEqual([0, 0, 0]); } finally { release(); }
  await expect.poll(() => counts(page)).toEqual([0, 0, 0]); expect(submits).toBe(0); expect((await page.request.get("/api/me")).status()).toBe(200);
});
