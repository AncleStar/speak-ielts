import fs from "node:fs/promises";
import pg from "pg";
import { test, expect, type Page, type BrowserContext } from "@playwright/test";

test.use({ extraHTTPHeaders: {Origin: "http://127.0.0.1:3100",  "x-forwarded-for": "192.0.2.121" }, actionTimeout: 20000 });
let owned: string | null = null;
test.beforeEach(() => { owned = null; });
test.afterEach(async ({ context }) => { if (owned) expect([200, 404]).toContain((await context.request.delete(`/api/sessions/${owned}`)).status()); });
async function login(page: Page, name: string) {
  await page.context().addInitScript(() => {
    const w = window as typeof window & { observedTracks: MediaStreamTrack[] }; w.observedTracks = [];
    const media = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async c => { const s = await media(c); w.observedTracks.push(...s.getTracks()); return s; };
  });
  await page.goto("/login"); await page.getByLabel("邮箱", { exact: true }).fill(`${name}@example.test`); await page.getByLabel("密码", { exact: true }).fill("Browser-test-123!"); await page.getByRole("button", { name: "登录", exact: true }).click(); await expect(page).not.toHaveURL(/\/login$/);
}
async function view(page: Page, id: string) { const r = await page.request.get(`/api/sessions/${id}`); expect(r.ok()).toBe(true); return r.json(); }
async function create(page: Page, mock = false) {
  const r = await page.request.post("/api/sessions", { data: mock ? { mode: "mock", mockSetId: "mock-1", fresh: true } : { mode: "practice", questionId: "P2-PERSON-1", fresh: true } }); expect(r.ok()).toBe(true); const { id } = await r.json(); owned = id;
  if (!mock) {
    // Only this synthetic test DB/session: keep its P2 recording open at real timing for lease polling.
    const pool = new pg.Pool({ connectionString: "postgres://postgres:postgres@127.0.0.1:5545/e2e" });
    try { await pool.query("update practice_session set plan=jsonb_set(plan,'{timeScale}','1'::jsonb) where id=$1", [id]); } finally { await pool.end(); }
  }
  await page.goto(`/interview/${id}`); await page.getByTestId("start-interview").click();
  if (!mock) { await expect(page.getByRole("button", { name: "开始回答", exact: true })).toBeVisible(); await page.getByRole("button", { name: "开始回答", exact: true }).click(); }
  await expect(page.getByTestId("recording-indicator")).toBeVisible(); await page.waitForTimeout(1200);
  return id as string;
}
async function stopped(page: Page) {
  await expect(page.getByTestId("interview-room")).toHaveAttribute("data-phase", "closed", { timeout: 15000 });
  await expect.poll(() => page.evaluate(() => (window as typeof window & { observedTracks: MediaStreamTrack[] }).observedTracks.every(t => t.readyState === "ended"))).toBe(true);
}
for (const offline of [false, true]) test(`${offline ? "offline" : "online"} original device preserves real audio after explicit takeover in an independent browser context`, async ({ page, context, browser }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await login(page, offline ? "device-offline" : "device-online"); const id = await create(page), original = await view(page, id);
  const peerContext = await browser.newContext({ storageState: await context.storageState(), permissions: ["microphone"], extraHTTPHeaders: {Origin: "http://127.0.0.1:3100",  "x-forwarded-for": "192.0.2.122" } });
  try {
    const peer = await peerContext.newPage(); peer.on("pageerror", e => errors.push(e.message)); await peer.goto(`http://127.0.0.1:3100/interview/${id}`);
    await expect(peer.getByTestId("start-interview")).toHaveText(/接管这次练习/);
    await peer.getByTestId("start-interview").click(); await expect(peer.getByRole("alertdialog", { name: "接管这次练习" })).toBeVisible();
    await peer.getByRole("button", { name: "取消", exact: true }).click(); expect((await view(peer, id)).session.activationId).toBe(original.session.activationId); await expect(page.getByTestId("recording-indicator")).toBeVisible();
    if (offline) await context.setOffline(true);
    await peer.getByTestId("start-interview").click(); await peer.getByTestId("confirm-takeover").click(); await expect(peer.getByRole("button", { name: "开始回答", exact: true })).toBeVisible();
    const taken = await view(peer, id); expect(taken.session.activationId).not.toBe(original.session.activationId);
    if (offline) { await expect(page.getByTestId("recording-indicator")).toBeVisible(); await context.setOffline(false); }
    await stopped(page);
    await expect.poll(async () => (await view(peer, id)).answers.some((a: { interrupted: boolean; recordingSource: string; status: string }) => a.interrupted && a.recordingSource === "previous_device" && a.status !== "created"), { timeout: 30000 }).toBe(true);
    await page.getByTestId("exit-interview").click(); await expect(page).toHaveURL(/\/practice/); expect((await view(peer, id)).session.activationId).toBe(taken.session.activationId); expect((await view(peer, id)).session.status).toBe("active");
    await peer.getByRole("button", { name: "开始回答", exact: true }).click(); await expect(peer.getByTestId("recording-indicator")).toBeVisible(); await peer.waitForTimeout(4500); await peer.getByRole("button", { name: "我答完了", exact: true }).click();
    let completedSnapshots = 0, finishRaceExercised = false;
    peer.on("response", async response => { if (response.url().endsWith(`/api/sessions/${id}/state`) && response.ok()) { const state = await response.json().catch(() => null); if (state?.status === "completed") completedSnapshots++; } });
    await peer.route(`**/api/sessions/${id}/events`, async route => {
      if (route.request().postDataJSON()?.type !== "finish") { await route.continue(); return; }
      const response = await route.fetch(); expect(response.ok()).toBe(true); expect((await response.json()).status).toBe("completed");
      // Commit has happened, but this page has not received its own completion response.
      await expect.poll(async () => { await peer.evaluate(() => window.dispatchEvent(new Event("focus"))); return completedSnapshots; }).toBeGreaterThan(0);
      await peer.waitForTimeout(100); await expect(peer.getByTestId("interview-room")).toHaveAttribute("data-phase", "finishing");
      finishRaceExercised = true; await route.fulfill({ response });
    });
    await peer.getByRole("button", { name: "完成本关", exact: true }).click();
    await expect(peer.getByTestId("interview-room")).toHaveAttribute("data-phase", "done", { timeout: 45000 });
    expect(finishRaceExercised).toBe(true);
    const saved = await view(peer, id); expect(saved.answers.some((a: { interrupted: boolean; recordingSource: string }) => !a.interrupted && a.recordingSource === "current_device")).toBe(true);
    const old = saved.answers.find((a: { recordingSource: string }) => a.recordingSource === "previous_device");
    const detail = await (await peer.request.get(`/api/answers/${old.id}`)).json(); expect(detail.answer.durationMs).toBeGreaterThan(1000); expect(detail.answer.hasAudio).toBe(true);
    await peer.goto(`http://127.0.0.1:3100/sessions/${id}`); await expect(peer.getByTestId("report-status")).toBeVisible();
    await expect(peer.getByText("旧设备补传片段：已保留录音，不计作当前设备的完整作答。", { exact: true })).toBeVisible();
    await peer.setViewportSize({ width: 320, height: 740 }); expect(await peer.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await peer.screenshot({ path: `data/verification/round20-${offline ? "offline" : "online"}-report-320.png`, fullPage: true }); expect(errors).toEqual([]);
    await fs.writeFile(`data/verification/round20-device-${offline ? "offline" : "online"}.json`, JSON.stringify({ passed: true, distinctBrowserContexts: true, actualMediaRecorder: true, actualServerDecode: true, explicitTakeover: true, cancelDoesNotMutate: true, oldExitDoesNotPauseNewDevice: true, oldAudioInterrupted: true, newAnswerComplete: true, offlineReconnect: offline, paidCalls: 0 }));
  } finally { await context.setOffline(false).catch(() => {}); await peerContext.close(); }
});
test("viewing a started mock on another device does not interrupt it; ending it requires confirmation", async ({ page, context, browser }) => {
  await login(page, "device-mock"); const id = await create(page, true), before = await view(page, id);
  const peerContext = await browser.newContext({ extraHTTPHeaders: { Origin: "http://127.0.0.1:3100" },  storageState: await context.storageState() });
  try {
    const peer = await peerContext.newPage(); await peer.goto(`http://127.0.0.1:3100/interview/${id}`);
    await expect(peer.getByText("模考正在原设备进行", { exact: true })).toBeVisible(); await expect(peer.getByTestId("start-interview")).toHaveCount(0);
    expect((await view(peer, id)).session.status).toBe("active"); expect((await view(peer, id)).session.partDeadlines).toEqual(before.session.partDeadlines);
    await peer.getByRole("button", { name: "结束当前模考", exact: true }).click(); await peer.getByRole("button", { name: "取消", exact: true }).click(); expect((await view(peer, id)).session.status).toBe("active");
    await peer.getByRole("button", { name: "结束当前模考", exact: true }).click(); await peer.getByRole("button", { name: "确认结束本次模考", exact: true }).click();
    await expect(peer.getByText("本次模考已中断", { exact: true })).toBeVisible(); await stopped(page);
    await expect.poll(async () => (await view(peer, id)).answers.some((a: { interrupted: boolean; status: string }) => a.interrupted && a.status !== "created"), { timeout: 30000 }).toBe(true);
    const after = await view(peer, id); expect(after.session.status).toBe("interrupted"); expect(after.session.partDeadlines).toEqual(before.session.partDeadlines);
    const restart = await peer.request.post(`/api/sessions/${id}/events`, { data: { type: "start", eventId: crypto.randomUUID(), expectedVersion: after.session.stateVersion } }); expect(restart.status()).toBe(409);
    await peer.screenshot({ path: "data/verification/round20-mock-viewer.png", fullPage: true });
  } finally { await peerContext.close(); }
});
