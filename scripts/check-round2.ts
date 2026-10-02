import "./_env";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { chromium } from "@playwright/test";
import { eq } from "drizzle-orm";
import { user } from "@/db/schema";
import { createAccount } from "@/lib/auth";
import { closeDb, db } from "@/lib/db";
import { env } from "@/lib/env";
import { checkIn } from "@/lib/services/rewards";
const destination = path.resolve("data/round2-review");
const email = `round2-check-${randomBytes(6).toString("hex")}@example.test`, password = randomBytes(24).toString("base64url");
let userId: string | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await fs.mkdir(destination, { recursive: true });
  const u = await createAccount({ email, password, name: "体验检查" }); userId = u.id;
  await db.update(user).set({ mustChangePassword: false, onboardedAt: new Date(), consentAt: new Date() }).where(eq(user.id, u.id));
  await checkIn(u.id);
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const base = env().BETTER_AUTH_URL;
  const checks: object[] = [];
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ["/login", "/register", "/password-help"]) {
      const response = await page.goto(`${base}${route}`); if (response?.status() !== 200) throw new Error(`Public route failed: ${route}`);
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`Overflow ${route} ${width}`);
      checks.push({ route, width, ok: true });
      if (route === "/login" && width !== 320) await page.screenshot({ path: path.join(destination, `login-${width}.png`), fullPage: true });
    }
  }
  await page.goto(`${base}/login`); await page.getByLabel("邮箱", { exact: true }).fill(email); await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click(); await page.waitForURL(url => url.pathname === "/");
  await page.locator("header").getByRole("button", { name: "暂停背景动画" }).click();
  await page.waitForFunction(() => document.querySelector(".ambient-background")?.getAttribute("data-paused") === "true");
  await page.goto(`${base}/levels`);
  await page.locator("header").getByRole("button", { name: "播放背景动画" }).click();
  await page.waitForFunction(() => document.querySelector(".ambient-background")?.getAttribute("data-paused") === "false");
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width > 800 ? 1040 : 844 });
    for (const route of ["/", "/levels", "/practice", "/growth", "/rewards", "/review", "/welcome", "/settings"]) {
      const response = await page.goto(`${base}${route}`); if (response?.status() !== 200) throw new Error(`Route failed: ${route}`);
      await page.locator("h1").first().waitFor();
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`Overflow ${route} ${width}`);
      checks.push({ route, width, ok: true });
      if ([1440,390].includes(width) && ["/", "/growth", "/review", "/welcome"].includes(route)) await page.screenshot({ path: path.join(destination, `${route === "/" ? "home" : route.slice(1)}-${width}.png`), fullPage: true });
    }
  }
  await page.getByLabel("外观", { exact: true }).selectOption("dark"); await page.getByLabel("减少动态效果").check();
  await page.setViewportSize({ width: 1440, height: 1040 }); await page.goto(`${base}/`);
  await page.screenshot({ path: path.join(destination, "home-dark.png"), fullPage: true });
  if (await page.locator(".ambient-background > i").first().evaluate(el => getComputedStyle(el).animationName) !== "none") throw new Error("Reduced-motion preference ignored");
  await db.update(user).set({ role: "admin" }).where(eq(user.id, u.id));
  await page.context().clearCookies();
  await page.goto(`${base}/login`); await page.getByLabel("邮箱", { exact: true }).fill(email); await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click(); await page.waitForURL(url => url.pathname === "/");
  for (const width of [320, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator("header").getByRole("link", { name: "管理", exact: true }).waitFor();
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`Admin navigation overflow ${width}`);
    checks.push({ route: "/", role: "admin", width, ok: true });
  }
  const health = await (await page.request.get(`${base}/api/health`)).json();
  const result = { at: new Date().toISOString(), browser: "Edge desktop; viewport emulation, not physical phones", checks, backgroundControls: { navigation: true, synchronized: true, persisted: true, reducedMotion: true }, browserErrors: errors, health, timeScale: env().TIME_SCALE, provider: env().AI_PROVIDER };
  await fs.writeFile(path.join(destination, "verification.json"), JSON.stringify(result, null, 2));
  if (errors.length) throw new Error(`${errors.length} browser exceptions`);
  console.log(JSON.stringify({ pages: checks.length, browserErrors: errors.length, timeScale: env().TIME_SCALE, screenshots: destination }));
} finally { await browser?.close(); if (userId) await db.delete(user).where(eq(user.id, userId)); await closeDb(); }
