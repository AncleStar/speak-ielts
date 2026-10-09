import path from "node:path";
import fs from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";

// Entire browser suite runs against a fresh, isolated database; never the developer's .env database.
const root = path.resolve(`data/verification/e2e-${Date.now()}`);
Object.assign(process.env, {
  DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5545/e2e",
  BETTER_AUTH_SECRET: "e2e-only-secret-00000000000000000000000", BETTER_AUTH_URL: "http://127.0.0.1:3100",
  AI_PROVIDER: "mock", TTS_PROVIDER: "mock", MOCK_TTS_TONE: "true", STORAGE_DRIVER: "local", DATA_DIR: root,
  LOCAL_STORAGE_DIR: path.join(root, "storage"), CONTENT_REQUIRE_REVIEW: "false", SEED_PUBLISH_DRAFTS: "true",
  ADMIN_EMAIL: "", ADMIN_INITIAL_PASSWORD: "", TIME_SCALE: "0.08", NODE_ENV: "production", APP_DOMAIN: "localhost",
});
const { startLocalPostgres } = await import("./local-db");
const pg = await startLocalPostgres({ dir: path.join(root, "pg"), port: 5545, dbName: "e2e", quiet: true });
await (await import("./migrate")).runMigrations();
await (await import("./seed")).seed({ tts: false, quiet: true });
const { createAccount } = await import("@/lib/auth");
const { db, closeDb } = await import("@/lib/db");
const { user } = await import("@/db/schema"); const { eq } = await import("drizzle-orm");
for (const name of ["onboarding", "learner", "outsider", "admin", "privacy-idea", "privacy-conflict", "privacy-recall", "privacy-upload", "privacy-denial", "privacy-recorder", "privacy-quota", "privacy-delete", "consent-interview", "consent-thought", "consent-device", "consent-pending-mic", "consent-upload"]) {
  const u = await createAccount({ email: `${name}@example.test`, password: "Browser-test-123!", name, role: name === "admin" ? "admin" : "user" });
  if (name !== "onboarding") await db.update(user).set({ mustChangePassword: false, consentAt: new Date(), onboardedAt: new Date(), dailyQuotaMinutes: 1000 }).where(eq(user.id, u.id));
}
await closeDb();
const { pcmFixture } = await import("./make-fixtures");
await fs.mkdir("tests/fixtures", { recursive: true });
await fs.writeFile("tests/fixtures/microphone.wav", pcmFixture(12));
const children: ChildProcess[] = [];
let stopping = false;
async function stop(code = 0) {
  if (stopping) return; stopping = true;
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    if (process.platform === "win32") await new Promise<void>(resolve => {
      const p = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      p.once("exit", () => resolve()); p.once("error", () => resolve());
    }); else child.kill("SIGTERM");
  }
  await pg.stop(); process.exit(code);
}
for (const args of [["--import", "tsx", "worker/index.ts"], ["node_modules/next/dist/bin/next", "start", "-p", "3100", "-H", "127.0.0.1"]]) {
  const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env, windowsHide: true }); children.push(child);
  child.once("error", () => void stop(1)); child.once("exit", code => { if (!stopping) void stop(code ?? 1); });
}
process.on("SIGINT", () => void stop()); process.on("SIGTERM", () => void stop());
