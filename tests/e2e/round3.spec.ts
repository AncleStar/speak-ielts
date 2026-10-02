import { test, expect } from "@playwright/test";

test("manual mock selection and resume on desktop and narrow screens", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto("/login"); await page.getByLabel("邮箱", { exact: true }).fill("learner@example.test");
  await page.getByLabel("密码", { exact: true }).fill("Browser-test-123!"); await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
  await page.goto("/mock");
  await expect(page.getByTestId("mock-paper-mock-1")).toBeVisible();
  expect(await page.locator('[data-testid^="mock-paper-"]').count()).toBe(5);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.screenshot({ path: "data/verification/round3-mock-desktop.png", fullPage: true });
  await page.getByTestId("start-mock-5").click(); await expect(page).toHaveURL(/\/interview\//);
  const sessionId = page.url().split("/").pop()!;
  await page.goto("/mock");
  await expect(page.getByTestId("mock-paper-mock-5").getByRole("link", { name: "继续这套模考" })).toHaveAttribute("href", `/interview/${sessionId}`);
  expect(errors).toEqual([]);
});
