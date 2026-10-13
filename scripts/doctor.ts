import "./_env";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { env, resetEnvCache } from "@/lib/env";
import { supervisorLockAlive } from "./supervisor-owner";

type Check = { id: string; label: string; state: "pass" | "warn" | "fail"; message: string; action?: string };
const checks: Check[] = [];
const add = (id: string, label: string, state: Check["state"], message: string, action?: string) => checks.push({ id, label, state, message, ...(action ? { action } : {}) });
let client: pg.Client | undefined;
try {
  const [major, minor] = process.versions.node.split(".").map(Number);
  add("node", "Node.js", major > 22 || major === 22 && minor >= 12 ? "pass" : "fail", major > 22 || major === 22 && minor >= 12 ? "满足 Node.js 22.12+ 要求" : "Node.js 版本过低", "安装 Node.js 22.12 或更新的受支持版本，再运行 npm ci。");
  // The managed local run supplies an instance token; adopt it only from a live process owned by this checkout.
  try { const local = JSON.parse(await fs.readFile("data/run/supervisor.json", "utf8").catch(() => "null")); if (!process.env.LOCAL_APP_INSTANCE?.trim() && local?.root === process.cwd() && supervisorLockAlive(local)) { process.env.LOCAL_APP_INSTANCE = local.instance; resetEnvCache(); } }
  catch { add("local_manager", "本机运行编号", "warn", "无法确认本机管理实例；后台检查不会采用未经验证的运行编号", "先使用查看应用状态入口核对，不要手动覆盖未知运行记录。"); }
  const e = env();
  add("configuration", "基础配置", "pass", "环境配置可解析；本次不会修改 .env 或启动服务");
  add("auth", "认证与密钥加密", e.BETTER_AUTH_SECRET.length >= 32 && (!e.USER_API_KEY_SECRET || e.USER_API_KEY_SECRET.length >= 32) ? "pass" : "fail", e.BETTER_AUTH_SECRET.length >= 32 && (!e.USER_API_KEY_SECRET || e.USER_API_KEY_SECRET.length >= 32) ? "认证及个人密钥加密配置满足长度要求，未输出密钥" : "认证密钥或个人密钥加密配置不足 32 字符", "在私有 .env 配置随机密钥；已有个人 Key 时不要随意更换加密密钥。");
  add("timing", "训练计时", e.TIME_SCALE === 1 ? "pass" : "warn", e.TIME_SCALE === 1 ? "正常计时" : "使用测试时间倍率，不能当作真人练习验收", "正式试用设置 TIME_SCALE=1，并同时重启网页与 worker。");
  const url = new URL(e.BETTER_AUTH_URL), loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const addressOk = ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  add("address", "访问地址", !addressOk ? "fail" : url.protocol === "http:" && !loopback ? "warn" : "pass", !addressOk ? "网站地址配置无效或包含用户凭据" : url.protocol === "http:" && !loopback ? "非回环地址使用 HTTP，手机麦克风需要 HTTPS 安全连接" : url.protocol === "https:" ? "已配置 HTTPS 地址，实际证书与反向代理仍需验收" : "本机回环地址可用于本机试用，不能据此证明手机可访问", "在目标部署环境配置正确的公开 HTTPS 地址；不要把密码写入 URL。");
  add("api", "AI 配置", e.AI_PROVIDER === "mock" ? "warn" : e.DASHSCOPE_API_KEY.trim() ? "pass" : "warn", e.AI_PROVIDER === "mock" ? "转写与反馈为模拟数据" : e.DASHSCOPE_API_KEY.trim() ? "站点 Key 已配置；未验证连接、权限、余额或教学质量" : "站点 Key 尚未配置；使用个人 Key 的账号需在自己的设置中配置", "真实连接测试另行选择，测试会计费；本命令不会派发云请求。");
  const { runProcess } = await import("@/lib/audio");
  try { const result = await runProcess(e.FFMPEG_PATH, ["-version"], { timeoutMs: 5000 }), valid = result.code === 0 && /^ffmpeg version\s+\S+/m.test(result.stdout.toString()); add("ffmpeg", "FFmpeg", valid ? "pass" : "fail", valid ? "FFmpeg 版本输出可识别；具体编码格式仍需训练流程验证" : "音频工具执行失败或不是 FFmpeg", "安装 FFmpeg 或检查 FFMPEG_PATH 后重试。"); }
  catch { add("ffmpeg", "FFmpeg", "fail", "音频工具不可执行或超过 5 秒未返回", "安装 FFmpeg 或检查 FFMPEG_PATH 后重试。"); }
  const build = await fs.readFile(".next/BUILD_ID", "utf8").catch(() => "");
  add("build", "生产构建", /^[\w-]{1,128}$/.test(build.trim()) ? "pass" : "warn", build.trim() ? "发现生产构建标识；这不验证源文件与构建内容一致" : "尚无生产构建", "更新源码后运行 npm run build；本机启动入口会检查源码指纹。");
  try {
    client = new pg.Client({ connectionString: e.DATABASE_URL, connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000 });
    await client.connect(); await client.query("BEGIN READ ONLY"); await client.query("SELECT 1");
    add("database", "数据库", "pass", "连接成功，后续检查在只读事务中执行");
    const { RECOVERY_STATE_KEY, RESTORE_PENDING_SCHEMA } = await import("@/lib/recovery-constants");
    const guard = await client.query("SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS pending, to_regclass('public.app_setting') AS settings", [RESTORE_PENDING_SCHEMA]);
    const recovery = guard.rows[0].settings ? (await client.query("SELECT value FROM app_setting WHERE key=$1", [RECOVERY_STATE_KEY])).rows[0]?.value : null;
    const recoveryBlocked = guard.rows[0].pending || recovery && recovery.status !== "approved";
    add("recovery", "恢复开放保护", recoveryBlocked ? "fail" : "pass", recoveryBlocked ? "恢复尚未完成或未通过开放核对，不能开始新训练" : "未发现待核对的恢复关闭保护", "按备份恢复说明完成账号、费用与配置核对；不要手动删除保护标记。");
    const { schema } = await import("@/db/schema"), { getTableConfig } = await import("drizzle-orm/pg-core");
    const columns = (await client.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'")).rows;
    const available = new Set(columns.map(r => `${r.table_name}.${r.column_name}`));
    const required = Object.values(schema).flatMap(table => { const t = getTableConfig(table); return t.columns.map(column => `${t.name}.${column.name}`); });
    const missing = required.filter(column => !available.has(column));
    add("schema", "必需表与列", missing.length ? "fail" : "pass", missing.length ? `缺少 ${missing.length} 个必需表列；不读取用户记录` : `已核对 ${required.length} 个必需表列；未检查全部约束`, "新安装运行 npm run setup；升级先完成备份，再执行迁移。");
    if (!missing.length) {
      const { evaluateWorkerHealth, runtimeConfigId, workerStateMessage } = await import("@/lib/worker-runtime");
      const rows = (await client.query("SELECT value,updated_at AS at FROM app_setting WHERE key LIKE 'runtime:worker:%'")).rows;
      const state = evaluateWorkerHealth(rows, runtimeConfigId(e));
      add("worker", "后台处理", state.ready ? "pass" : "fail", workerStateMessage(state.state), state.ready ? undefined : "统一网页/worker 配置和可见构建，停止旧后台后重启；旧心跳最多保留 60 秒。");
      const queues = await client.query("SELECT to_regclass('pgboss.queue') AS table_name");
      if (!queues.rows[0].table_name) add("queue", "任务队列", "fail", "任务队列表尚未准备", "先启动网页与 worker，再重试检查。");
      else {
        const { QUEUES, taskQueueName } = await import("@/lib/queue"), { TASK_RUNTIME_KEY, taskRuntimeId } = await import("@/lib/task-runtime");
        const record = (await client.query("SELECT value FROM app_setting WHERE key=$1", [TASK_RUNTIME_KEY])).rows[0]?.value;
        const matches = record?.protocol === 1 && record.id === taskRuntimeId();
        const names = new Set((await client.query("SELECT name FROM pgboss.queue")).rows.map(r => r.name)), absent = Object.values(QUEUES).map(taskQueueName).filter(name => !names.has(name));
        add("queue", "任务队列", !matches || absent.length ? "fail" : "pass", !matches ? "任务执行环境未匹配，原任务保留供核对" : absent.length ? `缺少 ${absent.length} 个当前环境队列` : "任务环境匹配且队列存在；不等于所有任务已处理", "首次安装启动当前网页与 worker；配置切换需暂停、停止旧后台并按部署说明明确启用。本命令不修改队列。");
      }
    }
    await client.query("ROLLBACK");
  } catch { add("database_checks", "数据库检查", "fail", "无法完成数据库检查；未输出连接地址、密码或原始错误", "检查数据库服务、连接配置和权限后重试。"); }
  const { checkVoiceReadiness } = await import("@/lib/services/voice-readiness");
  const voice = await checkVoiceReadiness();
  add("voice", "考官模型文件", voice.state === "ready" ? "pass" : voice.state === "not_required" ? "warn" : "fail", voice.message, voice.state === "unprepared" || voice.state === "unavailable" ? "运行 npm run setup:voice；成功后重启网页和 worker，再到设备检查页试听。" : undefined);
} catch { add("configuration", "配置检查", "fail", "配置、恢复状态或运行依赖尚未满足，后续检查未完成；未输出原始错误", "核对私有 .env 和恢复开放说明后重试；本命令不会修复或覆盖配置。"); }
finally { await client?.end().catch(() => {}); }
const report = { checkedAt: new Date().toISOString(), readOnly: true, paidCalls: 0, scope: "Local configuration, tool, schema, heartbeat, queue and model checks only; no cloud connectivity, balance, human, mobile or public deployment acceptance", status: checks.some(c => c.state === "fail") ? "blocked" : checks.some(c => c.state === "warn") ? "needs_attention" : "ok", checks };
if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
else { for (const c of checks) { console.log(`${c.state.toUpperCase()} ${c.label}：${c.message}`); if (c.state !== "pass" && c.action) console.log(`  下一步：${c.action}`); } console.log("自检没有修改配置、数据库或模型，也没有调用付费服务。真实手机、云服务与教学质量需分别验收。"); }
if (report.status === "blocked") process.exitCode = 1;
