import fs from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
test.use({ extraHTTPHeaders: { "x-forwarded-for": "192.0.2.141" } });
async function login(page: Page, name: string) {
  await page.goto("/login"); await page.getByLabel("邮箱", { exact: true }).fill(`${name}@example.test`); await page.getByLabel("密码", { exact: true }).fill("Browser-test-123!"); await page.getByRole("button", { name: "登录", exact: true }).click(); await expect(page).not.toHaveURL(/\/login$/);
}
test("admin sees a truthful mock status, retries a failed check and follows the voice-test link", async ({ page }) => {
  await login(page, "admin"); await page.goto("/admin/tts"); const section = page.getByTestId("voice-readiness"); await expect(section).toBeVisible();
  await section.getByRole("button", { name: "检查语音模型" }).click(); await expect(section.getByText("当前无需本机模型", { exact: true })).toBeVisible(); await expect(section.getByText("当前使用模拟语音", { exact: false })).toBeVisible();
  await page.route("**/api/admin/voice-status", route => route.abort(), { times: 1 }); await section.getByRole("button", { name: "检查语音模型" }).click(); await expect(section.getByText("当前未确认模型可用", { exact: false })).toBeVisible(); await expect(section.getByText("当前无需本机模型", { exact: true })).toHaveCount(0);
  await section.getByRole("button", { name: "检查语音模型" }).click(); await expect(section.getByText("当前无需本机模型", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 740 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); await page.screenshot({ path: "data/verification/round22-admin-voice-320.png", fullPage: true });
  await section.getByRole("link", { name: "去试听考官" }).click(); await expect(page).toHaveURL(/device-check/); await expect(page.getByTestId("voice-test")).toBeVisible();
});
test("ordinary accounts cannot query voice files or inspect the admin page", async ({ page, browser }) => {
  const anonymous = await browser.newContext(); try { expect((await anonymous.request.get("http://127.0.0.1:3100/api/admin/voice-status")).status()).toBe(401); } finally { await anonymous.close(); }
  await login(page, "outsider"); expect((await page.request.get("/api/admin/voice-status")).status()).toBe(404); await page.goto("/admin/tts"); await expect(page).not.toHaveURL(/\/admin\//); await expect(page.getByTestId("voice-readiness")).toHaveCount(0);
});
