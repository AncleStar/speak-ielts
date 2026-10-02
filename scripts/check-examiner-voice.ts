import "./_env";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { eq } from "drizzle-orm";
import { user, ttsAsset } from "@/db/schema";
import { createAccount } from "@/lib/auth";
import { db, closeDb } from "@/lib/db";
import { env, dataDir } from "@/lib/env";
import { ttsStatusCounts } from "@/lib/services/tts";

const email = `voice-check-${randomBytes(6).toString("hex")}@example.test`;
const password = randomBytes(24).toString("base64url");
let userId: string | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const created = await createAccount({ email, password, name: "Voice playback check" });
  userId = created.id;
  await db.update(user).set({ mustChangePassword: false, onboardedAt: new Date(), consentAt: new Date() }).where(eq(user.id, userId));
  browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage();
  await page.goto(`${env().BETTER_AUTH_URL}/login`);
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL(url => !url.pathname.endsWith("/login"));
  await page.goto(`${env().BETTER_AUTH_URL}/device-check`);
  await page.getByText("当前考官：Emma · 英式女声", { exact: true }).waitFor();
  const responsePromise = page.waitForResponse(r => r.url().includes("/api/tts/") && r.status() === 200, { timeout: 90000 });
  await page.getByTestId("voice-test").click();
  const response = await responsePromise;
  // 单独读取鉴权音频接口，避开 Chromium 对流式 fetch 响应体的 DevTools 缓冲差异。
  const downloaded = await page.request.get(response.url());
  assert.equal(downloaded.status(), 200);
  const sample = await downloaded.body();
  assert.match(response.headers()["content-type"], /audio/);
  assert.ok(sample.length > 1000, `Unexpected audio size: ${sample.length}`);
  await page.getByText("播放完成。", { exact: false }).waitFor({ timeout: 90000 });
  const playback = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const context = new AudioContext();
    const decoded = await context.decodeAudioData(bytes.buffer);
    const result = { duration: decoded.duration, sampleRate: decoded.sampleRate, channels: decoded.numberOfChannels };
    await context.close(); return result;
  }, sample.toString("base64"));
  assert.ok(playback.duration > 3);
  const [old] = await db.select().from(ttsAsset).where(eq(ttsAsset.model, "mock-local-tts")).limit(1);
  if (old) {
    const redirect = await page.request.get(`${env().BETTER_AUTH_URL}/api/tts/${old.id}`, { maxRedirects: 0 });
    assert.equal(redirect.status(), 307);
    assert.notEqual(redirect.headers().location, `/api/tts/${old.id}`);
  }
  const outDir = path.join(dataDir(), "voice-preview");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "device-check-emma.mp3"), sample);
  await page.screenshot({ path: path.join(outDir, "device-check.png"), fullPage: true });
  const report = { at: new Date().toISOString(), playback, oldAudioRedirect: !!old, counts: await ttsStatusCounts() };
  await fs.writeFile(path.join(outDir, "browser-check.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(error instanceof Error ? error.message.slice(0, 1000) : "Voice check failed");
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (userId) await db.delete(user).where(eq(user.id, userId));
  await closeDb();
}
