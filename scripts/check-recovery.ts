/** A complete local recovery drill with synthetic accounts, audio and mock AI. Never reads the business database. */
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { eq } from "drizzle-orm";
import { createBackup, restoreBackup } from "@/lib/backup";
import { pcmFixture } from "./make-fixtures";
import { approveRestoreReview, exportRecoveryLedger, prepareRestoreReview } from "@/lib/restore-review";

const root = path.resolve(`data/verification/recovery-${Date.now()}-${randomUUID().slice(0, 8)}`);
const source = path.join(root, "source"), restored = path.join(root, "restored"), origin = "http://127.0.0.1:3101";
const sourceUrl = "postgres://postgres:postgres@127.0.0.1:5553/recovery_source", targetUrl = "postgres://postgres:postgres@127.0.0.1:5553/recovery_target";
const password = "Recovery-test-only-123!", audio = pcmFixture(6), children: ChildProcess[] = [];
const checks: string[] = [];
let database: Awaited<ReturnType<typeof import("./local-db").startLocalPostgres>> | undefined;
let cookie = "";
let browser: Awaited<ReturnType<typeof import("@playwright/test").chromium.launch>> | undefined;
// Set every private/paid-service option before any module loads .env. FFmpeg and backup client paths may be reused.
Object.assign(process.env, {
  DATABASE_URL: sourceUrl, BETTER_AUTH_SECRET: "recovery-test-only-secret-000000000000000", USER_API_KEY_SECRET: "", BETTER_AUTH_URL: origin,
  DATA_DIR: source, LOCAL_STORAGE_DIR: path.join(source, "storage"), STORAGE_DRIVER: "local", RESTORE_FINALIZE: "false",
  AI_PROVIDER: "mock", TTS_PROVIDER: "mock", MOCK_TTS_TONE: "true", DASHSCOPE_API_KEY: "", ENABLE_AUDIO_DIAGNOSIS: "false",
  OSS_ACCESS_KEY_ID: "", OSS_ACCESS_KEY_SECRET: "", ADMIN_EMAIL: "", ADMIN_INITIAL_PASSWORD: "", TRUSTED_ORIGINS: "",
  CONTENT_REQUIRE_REVIEW: "false", SEED_PUBLISH_DRAFTS: "true", TIME_SCALE: "1", NODE_ENV: "production", APP_DOMAIN: "localhost", LOCAL_APP_INSTANCE: "",
});
async function freePort(port: number) {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(new Error(`演练端口 ${port} 已占用，未启动或停止任何现有服务`)));
    server.listen(port, "127.0.0.1", () => server.close(error => error ? reject(error) : resolve()));
  });
}
function check(name: string) { checks.push(name); console.log(`通过：${name}`); }
async function api(route: string, init: RequestInit = {}, status = 200, authenticated = true) {
  const headers = new Headers(init.headers); headers.set("Origin", origin);
  if (authenticated && cookie) headers.set("Cookie", cookie);
  const response = await fetch(`${origin}${route}`, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, status, `恢复环境接口 ${route.split("?")[0]} 状态异常`);
  return response;
}
const jsonBody = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function startChild(args: string[], label: string, environment: NodeJS.ProcessEnv) {
  const log = await fs.open(path.join(root, `${label}.log`), "a", 0o600);
  const child = spawn(process.execPath, args, { env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const writes: Promise<unknown>[] = [];
  child.stdout?.on("data", chunk => { writes.push(log.write(chunk)); });
  child.stderr?.on("data", chunk => { writes.push(log.write(chunk)); });
  child.once("close", () => { void Promise.allSettled(writes).then(() => log.close()); });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", () => reject(new Error(`演练 ${label} 无法启动`))); });
}
async function stopChildren() {
  for (const child of children) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
    if (process.platform === "win32") await new Promise<void>(resolve => {
      // Only handles created in this process can be stopped. Never search by port or process name.
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("exit", () => resolve()); killer.once("error", () => resolve());
    }); else child.kill("SIGTERM");
    await new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(resolve, 10_000); child.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }
}
async function waitForReady() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (children.some(child => child.exitCode !== null || child.signalCode !== null)) throw new Error("恢复环境服务提前退出，详见演练目录中的日志");
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2500) }).catch(() => null);
    if (response?.status === 200 && (await response.json()).ok === true) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("恢复环境 web / worker 就绪超时，详见演练目录中的日志");
}
try {
  await fs.stat(".next/BUILD_ID").catch(() => { throw new Error("请先完成 npm run build 再执行恢复演练"); });
  await freePort(5553); await freePort(3101);
  database = await (await import("./local-db")).startLocalPostgres({ dir: path.join(root, "pg"), port: 5553, dbName: "recovery_source", quiet: true });
  await database.createDatabase("recovery_target");
  await (await import("./migrate")).runMigrations(); await (await import("./seed")).seed({ tts: false, quiet: true });
  const { db } = await import("@/lib/db"), schema = await import("@/db/schema"), { createAccount, getAuth, resetPassword } = await import("@/lib/auth");
  const lab = await import("@/lib/services/thoughts"), sessions = await import("@/lib/services/sessions"), answers = await import("@/lib/services/answers");
  const deletion = await import("@/lib/services/deletion");
  const owner = await createAccount({ email: "recovery-owner@example.test", password, name: "Recovery owner" });
  const removed = await createAccount({ email: "recovery-deleted@example.test", password, name: "Recovery deleted" });
  for (const account of [owner, removed]) await db.update(schema.user).set({ mustChangePassword: false, consentAt: new Date(), onboardedAt: new Date(), dailyQuotaMinutes: 1000 }).where(eq(schema.user.id, account.id));
  const thought = await lab.generateThought(owner.id, { sourceText: "Students should gain practical experience.", requestId: randomUUID() });
  const goneThought = await lab.generateThought(owner.id, { sourceText: "Schools should offer more activities.", requestId: randomUUID() });
  await lab.enrollThought(owner.id, thought.id, 0);
  await lab.recordThoughtPractice(owner.id, thought.id, { action: "practice", revision: 0, requestId: randomUUID(), outcome: "remembered", recalledText: "Students should learn by doing.", durationSeconds: 3 });
  await lab.saveThoughtVocabulary(owner.id, { thoughtId: thought.id, revision: 0, indices: [0, 1] });
  const words = await lab.listVocabulary(owner.id), keptWord = words.items[0], goneWord = words.items[1];
  const keptSession = await sessions.createSession({ id: owner.id, consentAt: new Date() }, { mode: "practice", questionId: "P1-HOME-1", fresh: true });
  const goneSession = await sessions.createSession({ id: owner.id, consentAt: new Date() }, { mode: "practice", questionId: "P1-HOME-2", fresh: true });
  const ticket = await answers.createUploadTicket(owner.id, { sessionId: keptSession.id, planIndex: 0, kind: "main", submissionId: randomUUID(), clientDurationMs: 6000 });
  await answers.receiveAudio(owner.id, ticket.answerId, ticket.ticket, audio);
  await (await import("@/lib/jobs/process-answer")).processAnswer({ answerId: ticket.answerId }, { finalAttempt: true });
  const [recorded] = await db.select().from(schema.answer).where(eq(schema.answer.id, ticket.answerId));
  const audioHash = createHash("sha256").update(await fs.readFile(path.join(source, "storage", recorded.storageKey!))).digest("hex");
  const oldLogin = await getAuth().api.signInEmail({ body: { email: "recovery-owner@example.test", password }, asResponse: true });
  const oldCookie = oldLogin.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  assert.equal((await getAuth().api.getSession({ headers: new Headers({ Cookie: oldCookie }) }))?.user.id, owner.id, "源环境旧会话需先验证有效");
  await (await import("@/lib/ai/credentials")).saveAiConfig(owner.id, { mode: "personal", apiKey: "synthetic_recovery_key_never_dispatched", asrModel: "qwen3-asr-flash-2026-02-10", llmModel: "qwen-flash", monthlyBudgetYuan: 20, consent: true });
  const backup = await createBackup({ databaseUrl: sourceUrl, dataDirectory: source, storageDirectory: path.join(source, "storage"), backupDirectory: path.join(root, "backups"), storageDriver: "local" });
  const laterPassword = "Later-recovery-test-only-123!";
  await resetPassword(owner.id, laterPassword);
  // Monetary fixtures are ledger entries only; no real or synthetic provider request is dispatched here.
  await db.insert(schema.usageEvent).values({ userId: owner.id, billingSource: "personal", service: "asr", model: "synthetic-no-dispatch", units: { seconds: 10000 }, costYuan: 2.2, mock: false });
  await db.insert(schema.usageEvent).values({ billingSource: "platform", service: "tts", model: "synthetic-no-dispatch", units: { chars: 1000 }, costYuan: 0.5, mock: false });
  await lab.deleteThought(owner.id, goneThought.id); await lab.deleteVocabulary(owner.id, goneWord.id);
  await deletion.deleteSession(owner.id, goneSession.id, owner.id); await deletion.deleteUserAccount(removed.id, removed.id);
  await restoreBackup({ bundle: backup.directory, databaseUrl: targetUrl, dataDirectory: restored, currentDatabaseUrl: sourceUrl,
    currentDataDirectory: source, currentStorageDirectory: path.join(source, "storage"), latestDeletionLog: path.join(source, "deletion-log.jsonl") });
  check("实际备份、隔离恢复与最新删除日志重放");
  await (await import("@/lib/queue")).stopBoss(); await (await import("@/lib/db")).closeDb();
  const ledgerFile = path.join(root, "latest-costs.json");
  await exportRecoveryLedger(sourceUrl, ledgerFile);
  const prepared = await prepareRestoreReview(targetUrl, restored, ledgerFile);
  const environment = { ...process.env, DATABASE_URL: targetUrl, DATA_DIR: restored, LOCAL_STORAGE_DIR: path.join(restored, "storage") };
  await startChild(["node_modules/next/dist/bin/next", "start", "-p", "3101", "-H", "127.0.0.1"], "pending-web", environment);
  let pendingReady = false;
  for (const deadline = Date.now() + 120000; Date.now() < deadline;) {
    const response = await fetch(`${origin}/maintenance`, { signal: AbortSignal.timeout(2500) }).catch(() => null);
    if (response?.status === 200) { pendingReady = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(pendingReady, "恢复检查提示页未启动");
  for (const route of ["/api/me", "/api/auth/get-session"]) assert.equal((await (await api(route, {}, 503, false)).json()).error.code, "restore_review_required");
  await api("/api/auth/sign-in/email", jsonBody({ email: "recovery-owner@example.test", password }), 503, false);
  await api("/api/sessions", jsonBody({ mode: "practice", questionId: "P1-HOME-1" }), 503, false);
  await api("/api/health", {}, 503, false);
  const { chromium } = await import("@playwright/test");
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(); await page.goto(`${origin}/login`);
  assert.equal(new URL(page.url()).pathname, "/maintenance"); await page.getByRole("heading", { name: "资料恢复检查中" }).waitFor();
  await page.screenshot({ path: path.join(root, "maintenance-desktop.png") });
  await page.setViewportSize({ width: 320, height: 740 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(root, "maintenance-mobile.png") });
  check("未核对恢复拒绝登录、私有 API、新训练与健康检查，桌面和 320px 提示页可访问");
  // Losing the file does not bypass the independent database gate, even in the already running process.
  const reviewMarker = path.join(restored, "restore-review-pending.json"), markerBytes = await fs.readFile(reviewMarker);
  await fs.rm(reviewMarker);
  try {
    assert.equal((await (await api("/api/auth/get-session", {}, 503, false)).json()).error.code, "restore_review_required");
    await api("/api/health", {}, 503, false);
    await page.goto(`${origin}/login`); assert.equal(new URL(page.url()).pathname, "/maintenance");
  } finally { await fs.writeFile(reviewMarker, markerBytes, { flag: "wx", mode: 0o600, flush: true }); }
  check("丢失文件标记和缓存连接不会绕过数据库中的恢复检查");
  await context.close(); await stopChildren(); children.length = 0;
  const worksheet = JSON.parse(await fs.readFile(prepared.file, "utf8"));
  worksheet.accounts.forEach((account: { access: string }) => { account.access = "admin"; });
  worksheet.costs.forEach((cost: { totalYuan: number; minimumKnownYuan: number }) => { cost.totalYuan = cost.minimumKnownYuan; });
  worksheet.checks = { accountsAndPermissions: true, costsIncludingPendingCalls: true, deploymentAndSecrets: true };
  worksheet.evidence = "Synthetic stopped-source cost export; no paid API dispatch; isolated ports and mock providers"; worksheet.openNewSessions = true;
  await fs.writeFile(prepared.file, JSON.stringify(worksheet));
  const approval = await approveRestoreReview(targetUrl, restored, prepared.file);
  assert.equal((await approveRestoreReview(targetUrl, restored, prepared.file)).alreadyApproved, true);
  const credentials = JSON.parse(await fs.readFile(approval.credentialsFile, "utf8")), temporaryPassword = credentials.accounts.find((account: { userId: string }) => account.userId === owner.id).temporaryPassword;
  check("逐一核对权限、后续费用和配置后开放，重复审批不重复补记费用");
  await startChild(["--import", "tsx", "worker/index.ts"], "worker", environment);
  await startChild(["node_modules/next/dist/bin/next", "start", "-p", "3101", "-H", "127.0.0.1"], "web", environment);
  await waitForReady(); check("恢复环境实际 web / worker 健康检查");
  await api("/api/me", {}, 401, false); await api(`/api/answers/${ticket.answerId}/audio`, {}, 401, false);
  const revoked = await api("/api/auth/get-session", { headers: { Cookie: oldCookie } }, 200, false);
  assert.equal(await revoked.json(), null); check("匿名录音拒绝访问，旧登录会话不可使用");
  await api("/api/auth/sign-in/email", jsonBody({ email: "recovery-deleted@example.test", password }), 401, false);
  check("删除的账号不能登录");
  await api("/api/auth/sign-in/email", jsonBody({ email: "recovery-owner@example.test", password }), 401, false);
  await api("/api/auth/sign-in/email", jsonBody({ email: "recovery-owner@example.test", password: laterPassword }), 401, false);
  const login = await api("/api/auth/sign-in/email", jsonBody({ email: "recovery-owner@example.test", password: temporaryPassword }), 200, false);
  cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; "); assert.ok(cookie);
  const pendingProfile = (await (await api("/api/me")).json()).user; assert.equal(pendingProfile.id, owner.id); assert.equal(pendingProfile.mustChangePassword, true);
  assert.equal((await (await api("/api/sessions", jsonBody({ mode: "practice", questionId: "P1-HOME-1" }), 403)).json()).error.code, "must_change_password");
  const changedContext = await browser.newContext();
  await changedContext.addCookies(cookie.split("; ").map(value => { const index = value.indexOf("="); return { name: value.slice(0, index), value: value.slice(index + 1), url: origin }; }));
  const changedPage = await changedContext.newPage(); await changedPage.goto(`${origin}/change-password`);
  await changedPage.getByLabel("当前密码", { exact: true }).fill(temporaryPassword);
  await changedPage.getByLabel("新密码", { exact: true }).fill("Reviewed-recovery-test-only-123!");
  await changedPage.getByLabel("确认新密码", { exact: true }).fill("Reviewed-recovery-test-only-123!");
  await changedPage.getByRole("button", { name: "保存新密码", exact: true }).click();
  await changedPage.waitForURL(url => url.pathname === "/", { timeout: 30000 });
  cookie = (await changedContext.cookies(origin)).map(value => `${value.name}=${value.value}`).join("; ");
  assert.equal((await (await api("/api/me")).json()).user.mustChangePassword, false);
  const accountView = await (await api("/api/ai-settings")).json();
  assert.equal(accountView.personalMonthCost, 2.2); assert.equal(accountView.config.hasKey, false); assert.equal(accountView.config.monthlyBudgetYuan, 20);
  assert.equal(accountView.totals.find((total: { source: string }) => total.source === "personal").calls, 0);
  await changedContext.close(); await browser.close(); browser = undefined;
  // The restored user explicitly selects the site's mock service; never dispatch the snapshot's revoked personal key.
  await api("/api/ai-settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "platform", asrModel: "qwen3-asr-flash-2026-02-10", llmModel: "qwen-flash", monthlyBudgetYuan: 20, consent: false }) });
  check("旧密码与源库后来密码不能登录，实际浏览器强制改密；费用保留、预算不提高、个人 Key 需重新配置");
  const loaded = await (await api(`/api/thoughts/${thought.id}`)).json(); assert.equal(loaded.natural, thought.natural); assert.equal(loaded.review.completedCount, 1);
  const vocabulary = await (await api("/api/vocabulary")).json(); assert.ok(vocabulary.items.some((word: { id: string }) => word.id === keptWord.id)); assert.ok(!vocabulary.items.some((word: { id: string }) => word.id === goneWord.id));
  await api(`/api/thoughts/${goneThought.id}`, {}, 404); await api(`/api/sessions/${goneSession.id}`, {}, 404);
  check("观点、词汇和间隔复习保留，后来删除的内容不会复活");
  const detail = await (await api(`/api/answers/${ticket.answerId}`)).json(); assert.equal(detail.answer.status, "done"); assert.ok(detail.feedback);
  const replay = await api(`/api/answers/${ticket.answerId}/audio`);
  assert.equal(createHash("sha256").update(Buffer.from(await replay.arrayBuffer())).digest("hex"), audioHash);
  const range = await api(`/api/answers/${ticket.answerId}/audio`, { headers: { Range: "bytes=0-127" } }, 206); assert.equal((await range.arrayBuffer()).byteLength, 128);
  check("恢复报告与录音回放一致，Range 播放可用");
  for (const page of ["/", "/thoughts", "/vocabulary", "/review", "/growth", "/history", `/sessions/${keptSession.id}`]) {
    const response = await api(page); assert.match(response.headers.get("content-type") ?? "", /text\/html/); await response.text();
  }
  check("实际登录后的学习页面响应可用（不替代浏览器视觉验收）");
  const generated = await (await api("/api/thoughts", jsonBody({ sourceText: "Libraries should provide quiet places.", requestId: randomUUID() }))).json();
  assert.ok(generated.id); assert.equal(generated.mock, true); check("恢复后可以继续生成并保存观点（模拟服务）");
  const nextSession = await (await api("/api/sessions", jsonBody({ mode: "practice", questionId: "P1-HOME-3", fresh: true }), 201)).json();
  const nextTicket = await (await api("/api/answers/upload-ticket", jsonBody({ sessionId: nextSession.id, planIndex: 0, kind: "main", submissionId: randomUUID(), clientDurationMs: 6000 }))).json();
  await api(nextTicket.uploadUrl, { method: "PUT", headers: { "Content-Type": "audio/wav" }, body: new Uint8Array(audio) });
  await api(`/api/answers/${nextTicket.answerId}/submit`, { method: "POST" });
  let completed = false; const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await (await api(`/api/answers/${nextTicket.answerId}`)).json();
    if (result.answer.status === "done") { assert.ok(result.answer.transcript); assert.ok(result.feedback); completed = true; break; }
    assert.notEqual(result.answer.status, "failed", "恢复后的后台录音处理失败");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(completed, "恢复后的后台录音处理超时"); check("恢复后新录音通过实际上传、队列、worker 转码和模拟反馈");
  const pending = path.join(restored, "restore-pending.json");
  await fs.writeFile(pending, JSON.stringify({ recoveryDrill: true }), { flag: "wx" });
  try {
    for (const route of ["/api/me", "/api/auth/get-session"]) {
      const unavailable = await api(route, {}, 503); assert.equal((await unavailable.json()).error.code, "restore_incomplete");
    }
    await api("/api/auth/sign-in/email", jsonBody({ email: "recovery-owner@example.test", password }), 503, false);
    await api("/api/health", {}, 503, false);
  } finally { await fs.rm(pending); }
  await waitForReady(); assert.equal((await (await api("/api/me")).json()).user.id, owner.id);
  check("即使已缓存连接和登录，恢复未完成仍拒绝服务并返回明确 503");
  await fs.writeFile(path.join(root, "acceptance.json"), JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), checks,
    sourceDatabase: "fresh-synthetic-only", externalApiCalls: 0, actualWebAndWorker: true, browserChecks: ["maintenance-desktop", "maintenance-320px", "forced-password-change"], browserVisualReview: false, realVoiceQualityReview: false }, null, 2));
  console.log(`恢复演练完成。报告：${path.join(root, "acceptance.json")}`);
} catch (error) {
  console.error(error instanceof assert.AssertionError ? `恢复验收失败：${error.message}` : error instanceof Error ? error.message : "恢复演练失败");
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await stopChildren();
  await (await import("@/lib/queue")).stopBoss().catch(() => {});
  await (await import("@/lib/db")).closeDb().catch(() => {});
  await database?.stop();
}
