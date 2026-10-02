import "./_env";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import pg from "pg";
import { sourceFingerprint } from "./build-fingerprint";

// A supervisor only stops and restarts children that it created in this checkout.
const root = process.cwd(), runDir = path.resolve("data/run");
fs.mkdirSync(runDir, { recursive: true });
const instance = process.argv.find(a => a.startsWith("--instance="))?.slice(11) ?? randomUUID();
if (!/^[\w-]+$/.test(instance)) throw new Error("无效的本机运行标识");
process.env.LOCAL_APP_INSTANCE = instance;
const lockPath = path.join(runDir, "supervisor.lock"), statePath = path.join(runDir, "supervisor.json");
try { fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, instance }), { flag: "wx" }); }
catch {
  const old = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid: number };
  let alive = true; try { process.kill(old.pid, 0); } catch (e) { alive = (e as NodeJS.ErrnoException).code !== "ESRCH"; }
  if (alive) { console.log("本目录已有应用管理进程，请使用查看状态或重启入口。"); process.exit(0); }
  fs.unlinkSync(lockPath);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, instance }), { flag: "wx" });
}
let embedded: Awaited<ReturnType<typeof import("./local-db").startLocalPostgres>> | undefined;
let stopping = false, stage = "starting", message = "正在准备本机应用";
const children = new Map<string, ChildProcess>(), retries = new Map<string, number[]>();
const startedAt = new Date().toISOString();
const appUrl = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000");
const port = Number(process.env.PORT || appUrl.port || 3000);
function state() {
  const temp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ pid: process.pid, instance, root, startedAt, updatedAt: new Date().toISOString(), status: stage, message, url: appUrl.origin, children: Object.fromEntries([...children].map(([k,v]) => [k,v.pid])) }));
  fs.renameSync(temp, statePath);
}
async function killChild(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") await new Promise<void>(resolve => {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.once("exit", () => resolve()); killer.once("error", () => resolve());
  }); else child.kill("SIGTERM");
}
async function stop(code = 0) {
  if (stopping) return; stopping = true;
  stage = code ? "failed" : "stopping"; if (!code) message = "正在停止本次启动的服务"; state();
  await Promise.all([...children.values()].map(killChild)); children.clear();
  await embedded?.stop().catch(() => {});
  if (fs.existsSync(lockPath) && JSON.parse(fs.readFileSync(lockPath, "utf8")).instance === instance) fs.unlinkSync(lockPath);
  fs.rmSync(path.join(runDir, `stop-${instance}`), { force: true });
  stage = code ? "failed" : "stopped"; if (!code) message = "应用已停止，账号与练习记录保留"; state();
  process.exit(code);
}
state();
process.on("SIGINT", () => void stop()); process.on("SIGTERM", () => void stop());
setInterval(() => { if (fs.existsSync(path.join(runDir, `stop-${instance}`))) void stop(); else if (!stopping) state(); }, 2000).unref();
function startService(name: string, args: string[]) {
  if (stopping) return;
  const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit", windowsHide: true, env: process.env });
  children.set(name, child); state();
  let handled = false;
  const exited = () => {
    if (handled || stopping) return; handled = true; children.delete(name);
    const attempts = (retries.get(name) ?? []).filter(t => Date.now() - t < 10 * 60_000);
    attempts.push(Date.now()); retries.set(name, attempts);
    if (attempts.length > 3) { message = `${name} 连续退出，已停止自动重试。请查看 data/run/app.err.log 后重新启动。`; console.error(message); void stop(1); return; }
    stage = "recovering"; message = `${name} 意外退出，正在自动恢复（${attempts.length}/3）`; console.error(message); state();
    setTimeout(() => startService(name, args), attempts.length * 2000);
  };
  child.once("error", exited); child.once("exit", exited);
}
try {
  if (!fs.existsSync(".env")) {
    const { randomBytes } = await import("node:crypto");
    const template = fs.readFileSync(".env.example", "utf8").replace(/^BETTER_AUTH_SECRET=.*$/m, `BETTER_AUTH_SECRET=${randomBytes(32).toString("hex")}`).replace(/^ADMIN_INITIAL_PASSWORD=.*$/m, `ADMIN_INITIAL_PASSWORD=${randomBytes(18).toString("base64url")}`);
    fs.writeFileSync(".env", template, { flag: "wx", mode: 0o600 });
    (await import("./_env")).loadDotEnv();
    console.log("已创建本机 .env，初始账号与密码请在文件中查看。");
  }
  await new Promise<void>((resolve, reject) => { const probe = net.createServer(); probe.once("error", () => reject(new Error(`端口 ${port} 已被占用；未停止其他程序。请使用状态入口检查。`))); probe.listen(port, "127.0.0.1", () => probe.close(() => resolve())); });
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("请在 .env 配置 DATABASE_URL");
  const dbUrl = new URL(connectionString), probe = new pg.Client({ connectionString, connectionTimeoutMillis: 2000 });
  try { await probe.connect(); }
  catch {
    if (!["localhost", "127.0.0.1"].includes(dbUrl.hostname) || dbUrl.port !== "5433") throw new Error("数据库无法连接，请检查配置的数据库服务。");
    embedded = await (await import("./local-db")).startLocalPostgres({ dir: path.resolve("data/pg"), port: 5433, dbName: dbUrl.pathname.slice(1), quiet: true });
  } finally { await probe.end().catch(() => {}); }
  await (await import("./migrate")).runMigrations();
  await (await import("./seed")).seed({ tts: false });
  await (await import("@/lib/db")).closeDb();
  if (process.argv.includes("--production")) {
    const hash = await sourceFingerprint(), marker = path.join(runDir, "build-fingerprint");
    if (!fs.existsSync(".next/BUILD_ID") || !fs.existsSync(marker) || fs.readFileSync(marker, "utf8") !== hash) {
      stage = "building"; message = "代码有更新，正在构建；首次可能需要一分钟"; state(); console.log(message);
      await new Promise<void>((resolve,reject) => {
        const build = spawn(process.execPath, ["node_modules/next/dist/bin/next", "build"], { cwd: root, windowsHide: true, stdio: "inherit" }); children.set("build", build); state();
        build.once("error", reject); build.once("exit", code => { children.delete("build"); code === 0 ? resolve() : reject(new Error("构建失败，请查看 data/run/app.err.log")); });
      });
      fs.writeFileSync(marker, hash);
    }
  }
  stage = "starting"; message = "正在启动网页与后台处理";
  startService("worker", ["--import", "tsx", "worker/index.ts"]);
  startService("web", ["node_modules/next/dist/bin/next", process.argv.includes("--production") ? "start" : "dev", "--hostname", "127.0.0.1", "--port", String(port)]);
  let checking = false;
  setInterval(async () => {
    if (checking || stopping) return; checking = true;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(4000) });
      const health = await response.json();
      if (health.app === "ielts-speaking" && health.ok) { stage = "ready"; message = "网页、数据库与后台处理均已就绪"; }
      else { stage = "degraded"; message = "服务尚未就绪，请检查数据库与后台处理状态"; }
    } catch { stage = "degraded"; message = "网页暂时不可访问，正在检查服务"; }
    finally { checking = false; if (!stopping) state(); }
  }, 5000).unref();
  console.log(`本机应用：${appUrl.origin}；可使用查看状态、重启应用、停止应用入口。`);
} catch (error) {
  message = error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/g, "[数据库地址已隐藏]") : "启动失败";
  console.error(message); await stop(1);
}
