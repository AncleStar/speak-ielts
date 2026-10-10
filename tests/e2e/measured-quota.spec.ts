import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pcmFixture } from "../../scripts/make-fixtures";
test.use({ extraHTTPHeaders: { "x-forwarded-for": "192.0.2.49" } });
test("server-decoded time pauses AI when quota is unavailable, preserves replay and resumes after another hold is released", async ({ page }) => {
  await page.goto("/login"); await page.getByLabel("邮箱", { exact: true }).fill("measured-quota@example.test"); await page.getByLabel("密码", { exact: true }).fill("Browser-test-123!"); await page.getByRole("button", { name: "登录", exact: true }).click(); await expect(page).not.toHaveURL(/\/login$/);
  const me = await (await page.request.get("/api/me")).json(), submissionId = randomUUID();
  const created = await page.request.post("/api/sessions", { data: { mode: "practice", questionId: "P1-HOME-1", fresh: true } }); expect(created.ok()).toBe(true); const { id } = await created.json();
  const paused = await page.request.post(`/api/sessions/${id}/events`, { data: { type: "pause", eventId: randomUUID(), expectedVersion: 0, pendingUploads: [{ submissionId, planIndex: 0, kind: "main", consentVersion: me.user.recordingConsentVersion }] } }); expect(paused.ok()).toBe(true);
  const ticketResponse = await page.request.post("/api/answers/upload-ticket", { data: { sessionId: id, submissionId, planIndex: 0, kind: "main", clientDurationMs: 1000, interrupted: true, consentVersion: me.user.recordingConsentVersion } }); expect(ticketResponse.ok()).toBe(true); const ticket = await ticketResponse.json();
  const competing = await page.request.post("/api/sessions", { data: { mode: "practice", questionId: "P1-HOME-2", fresh: true } }); expect(competing.ok()).toBe(true); const competitor = await competing.json();
  try {
    expect((await page.request.put(ticket.uploadUrl, { headers: { "Content-Type": "audio/wav" }, data: pcmFixture(4) })).ok()).toBe(true); expect((await page.request.post(`/api/answers/${ticket.answerId}/submit`)).ok()).toBe(true);
    await expect.poll(async () => (await (await page.request.get(`/api/answers/${ticket.answerId}`)).json()).answer.processingStage).toBe("quota_wait");
    expect((await (await page.request.get("/api/me")).json()).quota).toMatchObject({ uncoveredSeconds: 3, remainingSeconds: 0, extraSeconds: 0 });
    await page.goto(`/answers/${ticket.answerId}`); await expect(page.getByRole("button", { name: "核对额度并继续" })).toBeVisible(); await expect(page.getByRole("link", { name: "积分兑换分钟券" })).toBeVisible();
    await expect(page.getByTestId("disc-scene")).toHaveAttribute("data-renderer", "ready");
    await page.getByRole("button", { name: "播放录音", exact: true }).click(); await expect.poll(() => page.locator("audio").evaluate((element: HTMLAudioElement) => element.ended), { timeout: 15000 }).toBe(true);
    // Capture after real playback and the original reveal, not an intermediate loading curtain.
    await page.screenshot({ path: "data/verification/round9-quota-wait-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 320, height: 740 }); await page.screenshot({ path: "data/verification/round9-quota-wait-320.png", fullPage: true }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.getByRole("button", { name: "核对额度并继续" }).click(); await expect(page.getByText("录音实测时长还有 3 秒未覆盖", { exact: false })).toBeVisible();
    const release = await page.request.post(`/api/sessions/${competitor.id}/events`, { data: { type: "pause", expectedVersion: 0, eventId: randomUUID() } }); expect(release.ok()).toBe(true);
    await page.getByRole("button", { name: "核对额度并继续" }).click(); await expect.poll(async () => (await (await page.request.get(`/api/answers/${ticket.answerId}`)).json()).answer.status).toBe("done");
    expect((await (await page.request.get("/api/me")).json()).quota).toMatchObject({ uncoveredSeconds: 0, extraSeconds: 1, reservedSeconds: 0 });
  } finally {
    await page.request.post(`/api/sessions/${competitor.id}/events`, { data: { type: "pause", expectedVersion: 0, eventId: randomUUID() } });
  }
});
