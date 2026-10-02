import path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e", fullyParallel: false, workers: 1, retries: 0, timeout: 120000,
  expect: { timeout: 15000 }, reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:3100", channel: process.platform === "win32" ? "msedge" : "chromium",
    viewport: { width: 1440, height: 1000 }, permissions: ["microphone"],
    launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${path.resolve("tests/fixtures/microphone.wav")}`, "--autoplay-policy=no-user-gesture-required"] },
    screenshot: "only-on-failure", trace: "retain-on-failure",
  },
  webServer: {
    command: "npx tsx scripts/test-server.ts", url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false, timeout: 120000,
  },
});
