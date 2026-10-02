import "./_env";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { chromium } from "@playwright/test";
import { eq, sql } from "drizzle-orm";
import { user } from "@/db/schema";
import { createAccount } from "@/lib/auth";
import { closeDb, db } from "@/lib/db";
import { env } from "@/lib/env";
import { providers } from "@/lib/providers";

const destination = path.resolve("data/plan-a-review");
const email = `plan-a-check-${randomBytes(6).toString("hex")}@example.test`, password = randomBytes(24).toString("base64url");
let userId: string | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await fs.mkdir(destination, { recursive: true });
  const created = await createAccount({ email, password, name: "体验检查" }); userId = created.id;
  await db.update(user).set({ mustChangePassword: false, onboardedAt: new Date(), consentAt: new Date() }).where(eq(user.id, userId));
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1040 } });
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(`${env().BETTER_AUTH_URL}/login`); await page.getByLabel("邮箱", { exact: true }).fill(email); await page.getByLabel("密码", { exact: true }).fill(password); await page.getByRole("button", { name: "登录", exact: true }).click(); await page.waitForURL(url => url.pathname === "/");
  const checks: { route: string; width: number; overflow: boolean }[] = [];
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width > 800 ? 1040 : 844 });
    for (const route of ["/", "/growth", "/rewards", "/levels/1-2", "/settings"]) {
      const response = await page.goto(`${env().BETTER_AUTH_URL}${route}`); if (response?.status() !== 200) throw new Error(`Route failed ${route}`);
      await page.locator("h1").first().waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      checks.push({ route, width, overflow });
      if (overflow) throw new Error(`Horizontal overflow ${route} ${width}`);
      if ((width === 1440 || width === 390) && ["/", "/growth", "/rewards"].includes(route)) await page.screenshot({ path: path.join(destination, `${route === "/" ? "home" : route.slice(1)}-${width}.png`), fullPage: true });
      if (route === "/levels/1-2" && await page.getByTestId("start-level").count()) throw new Error("Locked level exposes start button");
    }
  }
  await page.getByLabel("外观", { exact: true }).selectOption("dark"); await page.getByLabel("减少透明效果").check(); await page.getByLabel("减少动态效果").check();
  await page.setViewportSize({ width: 1440, height: 1040 }); await page.goto(`${env().BETTER_AUTH_URL}/`);
  await page.screenshot({ path: path.join(destination, "home-dark.png"), fullPage: true });
  const reduced = await page.locator("header.glass-nav").evaluate(el => getComputedStyle(el).backdropFilter);
  if (reduced !== "none") throw new Error("Reduced transparency not respected");
  await page.emulateMedia({ reducedMotion: "reduce" });
  if (!await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)) throw new Error("Reduced-motion emulation failed");
  const health = await (await page.request.get(`${env().BETTER_AUTH_URL}/api/health`)).json();
  const result = { at: new Date().toISOString(), checks, errors, health, tts: providers().ttsIdentity(), timeScale: env().TIME_SCALE, reducedTransparency: reduced };
  await fs.writeFile(path.join(destination, "verification.json"), JSON.stringify(result, null, 2));
  if (errors.length) throw new Error(`Browser exceptions: ${errors.join("; ")}`);
  console.log(JSON.stringify({ pages: checks.length, browserErrors: errors.length, tts: result.tts, timeScale: result.timeScale, screenshots: destination }));
} finally {
  await browser?.close(); if (userId) await db.delete(user).where(eq(user.id, userId)); await closeDb();
}
