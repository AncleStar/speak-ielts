import { test, expect, type Page } from "@playwright/test";

async function login(page: Page, name = "learner") {
  await page.goto("/login"); await page.getByLabel("邮箱", { exact: true }).fill(`${name}@example.test`);
  await page.getByLabel("密码", { exact: true }).fill("Browser-test-123!"); await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}
async function start(page: Page, input: object) {
  const r = await page.request.post("/api/sessions", { data: input }); expect(r.ok(), await r.text()).toBe(true);
  const { id } = await r.json(); await page.goto(`/interview/${id}`);
  await page.getByRole("button", { name: "开始面试", exact: true }).click({ timeout: 60000 }); return id as string;
}

test("first login changes password, captures consent, records and plays a microphone test", async ({ page }) => {
  await login(page, "onboarding"); await expect(page).toHaveURL(/change-password/);
  await page.getByLabel("当前密码", { exact: true }).fill("Browser-test-123!");
  await page.getByLabel("新密码", { exact: true }).fill("Changed-browser-456!");
  await page.getByLabel("确认新密码", { exact: true }).fill("Changed-browser-456!");
  await page.getByRole("button", { name: "保存新密码" }).click(); await expect(page).toHaveURL(/onboarding/);
  await page.getByRole("checkbox").check(); await page.getByRole("button", { name: "保存并检查麦克风" }).click();
  await expect(page).toHaveURL(/device-check/); await page.getByTestId("mic-connect").click();
  await page.getByTestId("mic-test").click(); await expect(page.getByTestId("mic-test-audio")).toBeVisible();
  await page.getByTestId("mic-test-audio").evaluate(async (el: HTMLAudioElement) => { await el.play(); });
  await page.getByTestId("voice-test").click(); await expect(page.getByText("播放完成。", { exact: false })).toBeVisible();
});

test("level recording, report, replay, retry, ownership and deletion", async ({ page, browser }) => {
  await login(page);
  let interruptedUpload = false;
  await page.route("**/api/answers/*/audio?*", async route => {
    if (!interruptedUpload && route.request().method() === "PUT") { interruptedUpload = true; await route.fulfill({ status: 503, body: "temporary upload failure" }); }
    else await route.continue();
  });
  const id = await start(page, { mode: "level", levelId: "1-1" });
  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: i === 3 ? "完成本关" : "下一题", exact: true }).click({ timeout: 30000 });
  await expect(page.getByText("本次练习完成！", { exact: true })).toBeVisible();
  await page.screenshot({ path: "data/verification/level-completed.png", fullPage: true });
  await page.getByRole("link", { name: "查看本次报告" }).click(); await expect(page).toHaveURL(new RegExp(`/sessions/${id}`));
  await expect.poll(async () => {
    const data = await (await page.request.get(`/api/sessions/${id}`)).json(); return data.answers.filter((a: { status: string }) => a.status === "done").length;
  }, { timeout: 60000 }).toBe(4);
  expect(interruptedUpload).toBe(true);
  const data = await (await page.request.get(`/api/sessions/${id}`)).json(); const answerId = data.answers[0].id;
  const report = await (await page.request.get(`/api/sessions/${id}/report`)).json();
  expect(report.summary.goal.met).toBeNull(); expect(report.summary.goal.metCount).toBe(0);
  await page.goto(`/answers/${answerId}`); await expect(page.getByText("模拟", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "播放录音", exact: true }).click();
  await expect(page.getByTestId("record-player")).toHaveAttribute("data-playing", "true");
  await page.getByRole("tab", { name: "反馈报告", exact: true }).click();
  await page.getByRole("button", { name: "朗读参考回答" }).click();
  await expect(page.getByRole("button", { name: "朗读参考回答" })).toBeEnabled({ timeout: 30000 });
  await page.screenshot({ path: "data/verification/answer-report.png", fullPage: true });
  const other = await browser.newContext(); const outsider = await other.newPage(); await login(outsider, "outsider");
  expect((await other.request.get(`/api/answers/${answerId}`)).status()).toBe(404); expect((await other.request.get(`/api/answers/${answerId}/audio`)).status()).toBe(404); await other.close();
  await start(page, { mode: "retry", sourceAnswerId: answerId });
  await page.getByRole("button", { name: "完成本关", exact: true }).click(); await expect(page.getByText("本次练习完成！", { exact: true })).toBeVisible();
  const deleted = await page.request.delete(`/api/sessions/${id}`); expect(deleted.ok(), await deleted.text()).toBe(true);
  expect((await page.request.get(`/api/answers/${answerId}/audio`)).status()).toBe(404);
  await page.goto("/history"); await expect(page.getByRole("heading", { name: "我的记录盘" })).toBeVisible();
});

test("admin monitoring pages load and microphone denial shows recovery instructions", async ({ page }) => {
  await login(page, "admin");
  await page.goto("/");await expect(page.locator(".home-disc-artwork img")).toHaveAttribute("src","/models/rhine/record-disc.webp");
  await page.screenshot({path:"data/verification/rhine-admin-home.png",fullPage:true});
  for (const route of ["/admin", "/admin/users", "/admin/questions", "/admin/tts", "/admin/usage", "/admin/rewards"]) {
    const response = await page.goto(route); expect(response?.status()).toBe(200);
    await expect(page.getByText("Application error", { exact: false })).toHaveCount(0);
  }
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("Permission denied", "NotAllowedError"); }; });
  await page.goto("/device-check"); await page.getByTestId("mic-connect").click();
  await expect(page.getByText("麦克风不可用", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新检测" })).toBeVisible();
  await expect(page.getByTestId("device-continue")).toBeDisabled();
});

test("full three-part mock completes only after all part deadlines", async ({ page }) => {
  await login(page); const id = await start(page, { mode: "mock", mockSetId: "mock-1" });
  await expect(page.getByText("模考完成！", { exact: true })).toBeVisible({ timeout: 95000 });
  const result = await (await page.request.get(`/api/sessions/${id}`)).json();
  expect(result.session.status).toBe("completed");
  expect(Date.parse(result.session.partDeadlines["3"]) - Date.parse(result.session.partStarts["1"])).toBe(60000);
  expect(new Set(result.answers.map((a: { planIndex: number }) => result.plan.items[a.planIndex].part))).toEqual(new Set([1, 2, 3]));
  await page.screenshot({ path: "data/verification/mock-completed.png", fullPage: true });
});

test("narrow screen has no horizontal overflow and admin pages stay private", async ({ page }) => {
  await login(page); await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ["/", "/levels", "/practice", "/history", "/settings", "/growth", "/rewards"]) {
    await page.goto(route); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.goto("/levels"); await page.screenshot({ path: "data/verification/mobile-levels.png", fullPage: true });
  await page.goto("/admin"); await expect(page).toHaveURL("http://127.0.0.1:3100/");
});

test("check-in, admin compensation, redemption, calendar and appearance", async ({ page, browser }) => {
  await login(page, "outsider");
  await page.getByRole("link", { name: "SPEAK 首页", exact: true }).click();
  await page.getByTestId("reward-checkin").click(); await expect(page.getByText("已签到，本次获得 5 积分")).toBeVisible();
  await expect(page.getByTestId("reward-checkin")).toBeDisabled();
  await page.goto("/rewards"); await expect(page.getByTestId("points-balance")).toHaveText("5");
  expect((await page.request.post("/api/rewards", { data: { action: "checkin" }, headers: { Origin: "https://untrusted.example" } })).status()).toBe(403);
  const adminContext = await browser.newContext(); const admin = await adminContext.newPage(); await login(admin, "admin");
  await admin.goto("/admin/rewards"); await admin.getByLabel("用户", { exact: true }).selectOption({ label: "outsider · outsider@example.test" });
  await admin.getByLabel("调整积分（负数表示扣回）").fill("100"); await admin.getByLabel("调整原因", { exact: true }).fill("浏览器验收积分补发"); await admin.getByRole("button", { name: "提交积分调整" }).click(); await expect(admin.getByText("积分已调整，原因和管理员标识已记入流水。")).toBeVisible();
  await admin.getByRole("button", { name: "保存奖励规则" }).click(); await expect(admin.getByText("奖励规则已保存。", { exact: false })).toBeVisible();
  await page.reload(); await expect(page.getByTestId("points-balance")).toHaveText("105");
  await page.getByTestId("reward-redeem").click(); await expect(page.getByRole("dialog")).toBeVisible(); await page.getByRole("button", { name: "取消", exact: true }).click(); await expect(page.getByTestId("points-balance")).toHaveText("105");
  await page.getByTestId("reward-redeem").click(); await page.getByTestId("confirm-redeem").click(); await expect(page.getByText("兑换成功，分钟券已放入你的账户")).toBeVisible(); await expect(page.getByTestId("points-balance")).toHaveText("55");
  await expect(page.getByTestId("reward-redeem")).toBeDisabled();
  const wallet = await (await page.request.get("/api/rewards")).json(); const credit = wallet.credits[0];
  await admin.getByLabel("分钟券编号").fill(credit.id); await admin.getByLabel("延期天数").fill("3"); await admin.getByLabel("延期原因").fill("测试服务中断补偿"); await admin.getByRole("button", { name: "确认延期" }).click(); await expect(admin.getByText("分钟券已延期，操作已记录。")).toBeVisible();
  const extended = await (await page.request.get("/api/rewards")).json(); expect(Date.parse(extended.credits[0].expiresAt) - Date.parse(credit.expiresAt)).toBe(3 * 86400_000);
  await page.getByRole("button", { name: "再兑换一张" }).click(); await page.getByTestId("confirm-redeem").click(); await expect(page.getByTestId("points-balance")).toHaveText("5");
  expect((await (await page.request.get("/api/rewards")).json()).credits).toHaveLength(2);
  await page.goto("/growth"); await expect(page.getByText("签到 · 连续 1 天")).toBeVisible();
  await page.screenshot({ path: "data/verification/plan-a-calendar.png", fullPage: true });
  await page.getByRole("link", { name: "上个月", exact: true }).click(); await expect(page).toHaveURL(/month=/);
  await page.goto("/settings"); await page.getByLabel("外观", { exact: true }).selectOption("dark"); await page.getByLabel("减少透明效果").check(); await page.getByLabel("减少动态效果").check();
  await page.goto("/"); await expect(page.locator("html")).toHaveAttribute("data-theme", "dark"); await expect(page.locator("html")).toHaveAttribute("data-transparency", "reduced");
  await page.screenshot({ path: "data/verification/plan-a-dark.png", fullPage: true });
  await page.goto("/settings"); await page.getByLabel("外观", { exact: true }).selectOption("light");
  await page.goto("/"); await page.screenshot({ path: "data/verification/plan-a-home.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: "data/verification/plan-a-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 320, height: 700 }); await page.goto("/growth"); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto("/admin/rewards"); await expect(page).toHaveURL("http://127.0.0.1:3100/");
  await adminContext.close();
});
