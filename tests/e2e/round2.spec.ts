import { test, expect, type Page } from "@playwright/test";
async function login(page: Page, name = "learner") {
  await page.goto("/login"); await page.getByLabel("邮箱", { exact: true }).fill(`${name}@example.test`);
  await page.getByLabel("密码", { exact: true }).fill("Browser-test-123!"); await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}
test("invited signup, password help, short first experience and ambient controls", async ({ page, browser }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto("/login"); await page.screenshot({ path: "data/verification/round2-login-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "暂停背景动画" }).click();
  await expect(page.locator(".ambient-background")).toHaveAttribute("data-paused", "true");
  await page.getByRole("link", { name: "忘记密码？" }).click(); await expect(page.getByText("当前试用版未接入邮件服务", { exact: false })).toBeVisible();
  await login(page, "admin"); await page.goto("/admin/invites");
  await page.getByLabel("限定邮箱（可留空）").fill("invited@example.test"); await page.getByRole("button", { name: "生成邀请码" }).click();
  const code = (await page.getByTestId("invite-code").textContent())!;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["microphone"] }); const learner = await context.newPage();
  learner.on("pageerror", e => errors.push(e.message)); await learner.goto("/register");
  await learner.getByLabel("昵称", { exact: true }).fill("受邀学员"); await learner.getByLabel("邮箱", { exact: true }).fill("invited@example.test");
  await learner.getByLabel("设置密码").fill("Invited-browser-123!"); await learner.getByLabel("邀请码", { exact: true }).fill(code);
  await learner.screenshot({ path: "data/verification/round2-register-mobile.png", fullPage: true });
  await learner.getByRole("button", { name: "创建账号" }).click(); await expect(learner).toHaveURL(/onboarding/);
  await learner.getByRole("checkbox").check(); await learner.getByRole("button", { name: "保存并检查麦克风" }).click();
  await expect(learner).toHaveURL(/device-check/); await learner.getByTestId("mic-connect").click(); await learner.getByTestId("mic-test").click();
  await expect(learner.getByTestId("mic-test-audio")).toBeVisible(); await learner.getByTestId("device-continue").click(); await expect(learner).toHaveURL(/welcome/);
  await expect(learner.getByTestId("start-first-practice")).toBeVisible();
  const reused = await learner.request.post("/api/register", { headers: { Origin: "http://127.0.0.1:3100" }, data: { email: "another@example.test", name: "another", password: "Invited-browser-123!", code } }); expect(reused.status()).toBe(400);
  for (const width of [320, 390, 768]) { await learner.setViewportSize({ width, height: 844 }); for (const route of ["/", "/review", "/welcome", "/growth", "/rewards"]) { await learner.goto(route); expect(await learner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); } }
  await learner.emulateMedia({ reducedMotion: "reduce" }); await learner.goto("/");
  expect(await learner.locator(".ambient-background > i").first().evaluate(el => getComputedStyle(el).animationName)).toBe("none");
  await expect(learner.getByRole("link", { name: /今日复习/ })).toBeVisible();
  expect(errors).toEqual([]); await context.close();
});

test("offline recording survives and hidden-page interruption can be retried", async ({ page, context }) => {
  await login(page);
  const r = await page.request.post("/api/sessions", { data: { mode: "practice", questionId: "P1-HOME-2", fresh: true } }); const { id } = await r.json();
  await page.goto(`/interview/${id}`); await page.getByRole("button", { name: "开始面试", exact: true }).click({ timeout: 60000 });
  await expect(page.getByTestId("recording-indicator")).toBeVisible();
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect(page.getByRole("button", { name: "重答本题", exact: true })).toBeVisible();
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.getByRole("button", { name: "重答本题", exact: true }).click(); await expect(page.getByTestId("recording-indicator")).toBeVisible();
  await context.setOffline(true); await expect(page.getByText("网络已断开。", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "我答完了", exact: true }).click();
  await page.getByRole("button", { name: "完成本关", exact: true }).click();
  await expect(page.getByRole("button", { name: "重试上传", exact: true })).toBeVisible();
  await context.setOffline(false); await page.getByRole("button", { name: "重试上传", exact: true }).click();
  await expect(page.getByText("本次练习完成！", { exact: true })).toBeVisible();
  const data = await (await page.request.get(`/api/sessions/${id}`)).json();
  expect(data.answers.some((a: { interrupted: boolean }) => a.interrupted)).toBe(true);
  expect(data.answers.some((a: { interrupted: boolean; status: string }) => !a.interrupted && a.status !== "created")).toBe(true);
});
