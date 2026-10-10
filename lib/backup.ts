import fs from "node:fs/promises";
import { createReadStream, constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import pg from "pg";
import { z } from "zod";
import { mergeDeletionLogs, parseDeletionLog } from "@/lib/deletion-log";

const fileSchema = z.object({ path: z.string().min(1).max(600), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const manifestSchema = z.object({ format: z.literal("speak-backup-v1"), createdAt: z.string().datetime(), databaseMajor: z.literal(17),
  storageDriver: z.literal("local"), files: z.array(fileSchema).min(2).max(1_000_000) });
export type BackupManifest = z.infer<typeof manifestSchema>;
export interface BackupOptions { databaseUrl: string; dataDirectory: string; storageDirectory: string; backupDirectory: string; storageDriver: "local" | "oss" }
export interface RestoreOptions { bundle: string; databaseUrl: string; dataDirectory: string; currentDatabaseUrl: string;
  currentDataDirectory: string; currentStorageDirectory: string; latestDeletionLog: string; noLaterDeletions?: boolean }

const exists = async (file: string) => fs.lstat(file).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return false; throw e; });
function inside(root: string, target: string) { const relative = path.relative(root, target); return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)); }
function safeRelative(file: string) {
  if (file === "database.dump" || file === "deletion-log.jsonl") return;
  if (!file.startsWith("storage/") || !/^[A-Za-z0-9/_.-]+$/.test(file) || file.includes("..") || file.endsWith("/") || file.includes("//")) throw new Error("备份包含无效文件路径");
}
async function realLocation(file: string): Promise<string> {
  const absolute = path.resolve(file);
  if (await exists(absolute)) return fs.realpath(absolute);
  const parent = path.dirname(absolute);
  if (parent === absolute) throw new Error("目标目录无法解析");
  return path.join(await realLocation(parent), path.basename(absolute));
}
async function regularFile(file: string) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("备份文件必须是普通文件，不能使用符号链接");
  return stat;
}
async function hashFile(file: string) {
  const stat = await regularFile(file), hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return { bytes: stat.size, sha256: hash.digest("hex") };
}
async function walk(root: string, relative = ""): Promise<string[]> {
  const stat = await fs.lstat(path.join(root, relative));
  if (stat.isSymbolicLink()) throw new Error("备份目录不能包含符号链接");
  if (stat.isFile()) return [relative.split(path.sep).join("/")];
  if (!stat.isDirectory()) throw new Error("备份目录包含不支持的文件");
  const result: string[] = [];
  for (const entry of (await fs.readdir(path.join(root, relative))).sort()) result.push(...await walk(root, path.join(relative, entry)));
  return result;
}
function databaseUrl(value: string) {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname.length < 2) throw new Error("请配置有效 PostgreSQL 连接");
  return url;
}
function connectionEnv(value: string) {
  const url = databaseUrl(value);
  const childEnv: NodeJS.ProcessEnv = { ...process.env, PGHOST: url.hostname.replace(/^\[|\]$/g, ""), PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGCONNECT_TIMEOUT: "10" };
  const options: Record<string, string> = { sslmode: "PGSSLMODE", sslrootcert: "PGSSLROOTCERT", sslcert: "PGSSLCERT", sslkey: "PGSSLKEY", channel_binding: "PGCHANNELBINDING", connect_timeout: "PGCONNECT_TIMEOUT", options: "PGOPTIONS" };
  for (const [key, value] of url.searchParams) { if (!options[key]) throw new Error("数据库连接参数不受备份工具支持，请使用 libpq 支持的 SSL 参数"); childEnv[options[key]] = value; }
  return childEnv;
}
async function run(command: string, args: string[], environment: NodeJS.ProcessEnv, label: string, timeout = 600_000) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", timedOut = false;
    child.stdout.on("data", chunk => { if (output.length < 100_000) output += String(chunk); });
    // Tool diagnostics can contain restored SQL and personal values. Never print or persist them.
    child.stderr.resume();
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.once("error", () => { clearTimeout(timer); reject(new Error(`${label} 无法运行，请检查客户端路径与权限`)); });
    child.once("close", code => { clearTimeout(timer); code === 0 && !timedOut ? resolve(output) : reject(new Error(`${label} ${timedOut ? "超时" : "失败"}，请检查数据库连接、客户端版本、权限与磁盘空间`)); });
  });
}
export async function resolvePgTool(name: "pg_dump" | "pg_restore") {
  const custom = process.env[name === "pg_dump" ? "PG_DUMP_PATH" : "PG_RESTORE_PATH"];
  const local = path.resolve(`data/tools/postgres-17/bin/${name}${process.platform === "win32" ? ".exe" : ""}`);
  for (const candidate of custom ? [custom] : [local, name]) {
    try { const version = await run(candidate, ["--version"], process.env, name, 10_000); if (!new RegExp(`^${name} \\(PostgreSQL\\) 17\\.`).test(version.trim())) throw new Error("客户端主版本必须为 PostgreSQL 17"); return candidate; }
    catch (error) { if (custom) throw error; }
  }
  throw new Error("未找到 PostgreSQL 17 备份客户端。Windows 运行 npm run setup:backup；其他系统安装 PostgreSQL 17 客户端或配置 PG_DUMP_PATH / PG_RESTORE_PATH。");
}
async function readLog(file: string) {
  const stat = await regularFile(file);
  if (stat.size > 64 * 1024 * 1024) throw new Error("删除日志过大，请先检查日志");
  const text = await fs.readFile(file, "utf8"); parseDeletionLog(text); return text;
}

/** The database uses one exported snapshot; referenced audio must exist in the copied storage. */
export async function createBackup(options: BackupOptions) {
  if (options.storageDriver !== "local") throw new Error("本机完整备份仅支持本地存储。OSS 数据需独立备份，不生成缺少音频的完整备份。");
  const root = await realLocation(options.backupDirectory), storage = await realLocation(options.storageDirectory);
  if (inside(storage, root) || inside(root, storage)) throw new Error("备份目录与音频存储目录不能相互包含");
  const tool = await resolvePgTool("pg_dump"), client = new pg.Client({ connectionString: options.databaseUrl, connectionTimeoutMillis: 10_000 });
  const name = `interview-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const stage = path.join(root, name + ".partial"), target = path.join(root, name);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.mkdir(stage, { mode: 0o700 });
  let transaction = false;
  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); transaction = true;
    if (Math.floor(Number((await client.query("SHOW server_version_num")).rows[0].server_version_num) / 10000) !== 17) throw new Error("当前备份支持 PostgreSQL 17 数据库");
    const snapshot = (await client.query("SELECT pg_export_snapshot() AS id")).rows[0].id as string;
    const keys = (await client.query<{ key: string }>("SELECT storage_key AS key FROM answer WHERE storage_key IS NOT NULL AND audio_deleted_at IS NULL AND created_at >= now() - interval '30 days' UNION SELECT storage_key AS key FROM tts_asset WHERE storage_key IS NOT NULL AND status = 'ready'")).rows;
    await run(tool, ["--no-password", "--format=custom", `--snapshot=${snapshot}`, "--file", path.join(stage, "database.dump")], connectionEnv(options.databaseUrl), "pg_dump");
    await fs.mkdir(path.join(stage, "storage"));
    if (await exists(storage)) for (const key of await walk(storage)) {
      safeRelative(`storage/${key}`);
      const destination = path.join(stage, "storage", key);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(storage, key), destination, constants.COPYFILE_EXCL);
    }
    for (const row of keys) { safeRelative(`storage/${row.key}`); if (!await exists(path.join(stage, "storage", row.key))) throw new Error("快照中有缺失的音频文件，未生成完整备份。请停止正在修改音频的服务后重试。"); }
    const logFile = path.join(await realLocation(options.dataDirectory), "deletion-log.jsonl");
    const log = await exists(logFile) ? await readLog(logFile) : "";
    await fs.writeFile(path.join(stage, "deletion-log.jsonl"), log, { flag: "wx", mode: 0o600, flush: true });
    const files = [];
    for (const file of await walk(stage)) files.push({ path: file, ...await hashFile(path.join(stage, file)) });
    const manifest: BackupManifest = { format: "speak-backup-v1", createdAt: new Date().toISOString(), databaseMajor: 17, storageDriver: "local", files };
    await fs.writeFile(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600, flush: true });
    await client.query("COMMIT"); transaction = false;
    await fs.rename(stage, target);
    return { directory: target, files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) };
  } catch (error) {
    if (transaction) await client.query("ROLLBACK").catch(() => {});
    if (!inside(root, stage) || stage === root) throw new Error("备份清理路径错误");
    await fs.rm(stage, { recursive: true, force: true });
    throw error;
  } finally { await client.end().catch(() => {}); }
}

export async function inspectBackup(bundle: string) {
  const root = await fs.realpath(bundle), manifestFile = path.join(root, "manifest.json");
  const stat = await regularFile(manifestFile);
  if (stat.size > 64 * 1024 * 1024) throw new Error("备份清单过大");
  const manifest = manifestSchema.parse(JSON.parse(await fs.readFile(manifestFile, "utf8")));
  const seen = new Set<string>();
  for (const file of manifest.files) {
    safeRelative(file.path);
    const unique = process.platform === "win32" ? file.path.toLowerCase() : file.path;
    if (seen.has(unique)) throw new Error("备份清单包含重复文件"); seen.add(unique);
    const actual = await hashFile(path.join(root, file.path));
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new Error("备份文件完整性校验失败");
  }
  if (!seen.has("database.dump") || !seen.has("deletion-log.jsonl")) throw new Error("备份缺少数据库或删除日志");
  const actualFiles = await walk(root);
  if (actualFiles.length !== manifest.files.length + 1 || actualFiles.some(f => f !== "manifest.json" && !seen.has(process.platform === "win32" ? f.toLowerCase() : f))) throw new Error("备份目录与清单不一致");
  await readLog(path.join(root, "deletion-log.jsonl"));
  return { root, manifest };
}

/** Restore only to a separately named, empty database and a new data directory. Never start services. */
export async function restoreBackup(options: RestoreOptions) {
  const source = databaseUrl(options.currentDatabaseUrl), destination = databaseUrl(options.databaseUrl);
  if (decodeURIComponent(source.pathname) === decodeURIComponent(destination.pathname)) throw new Error("恢复数据库必须使用不同于当前应用的新库名，禁止覆盖原库");
  const { root, manifest } = await inspectBackup(options.bundle), target = await realLocation(options.dataDirectory);
  const currentData = await realLocation(options.currentDataDirectory), currentStorage = await realLocation(options.currentStorageDirectory);
  if (target === currentData || [currentStorage, path.join(currentData, "pg"), root].some(dir => inside(dir, target) || inside(target, dir))) throw new Error("恢复目录不能覆盖当前数据、数据库、音频或备份");
  if (await exists(target)) throw new Error("恢复数据目录必须是尚不存在的新目录");
  const latest = await exists(options.latestDeletionLog) ? await readLog(options.latestDeletionLog) : options.noLaterDeletions ? "" : null;
  if (latest === null) throw new Error("未找到最新删除日志。请提供 RESTORE_LATEST_DELETION_LOG；仅在确认没有备份后的删除操作时设置 RESTORE_NO_LATER_DELETIONS=true。");
  const merged = mergeDeletionLogs(await readLog(path.join(root, "deletion-log.jsonl")), latest);
  const tool = await resolvePgTool("pg_restore"), environment = connectionEnv(options.databaseUrl);
  await run(tool, ["--list", path.join(root, "database.dump")], environment, "pg_restore 检查", 30_000);
  const client = new pg.Client({ connectionString: options.databaseUrl, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    if (Math.floor(Number((await client.query("SHOW server_version_num")).rows[0].server_version_num) / 10000) !== manifest.databaseMajor) throw new Error("恢复目标必须为 PostgreSQL 17");
    const objects = await client.query("SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname NOT LIKE 'pg_%' UNION SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%' UNION SELECT n.nspname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') UNION SELECT n.nspname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%'");
    if (objects.rows.length) throw new Error("恢复目标数据库不是空库，禁止覆盖已有数据");
    if (Number((await client.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()")).rows[0].n)) throw new Error("恢复数据库正在被其他进程使用，请先停止该恢复环境的服务");
  } finally { await client.end().catch(() => {}); }
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.mkdir(target, { mode: 0o700 });
  await fs.writeFile(path.join(target, "restore-pending.json"), JSON.stringify({ startedAt: new Date().toISOString(), backupCreatedAt: manifest.createdAt, format: manifest.format }), { flag: "wx", mode: 0o600, flush: true });
  await fs.mkdir(path.join(target, "storage"));
  for (const file of manifest.files.filter(f => f.path.startsWith("storage/"))) {
    const destinationFile = path.join(target, file.path);
    await fs.mkdir(path.dirname(destinationFile), { recursive: true });
    await fs.copyFile(path.join(root, file.path), destinationFile, constants.COPYFILE_EXCL);
    if ((await hashFile(destinationFile)).sha256 !== file.sha256) throw new Error("恢复音频校验失败，请保留失败目录排查，勿启动服务");
  }
  await fs.writeFile(path.join(target, "deletion-log.jsonl"), merged, { flag: "wx", mode: 0o600, flush: true });
  await run(tool, ["--no-password", "--single-transaction", "--no-owner", "--no-acl", "--dbname", decodeURIComponent(destination.pathname.slice(1)), path.join(root, "database.dump")], environment, "pg_restore");
  await run(process.execPath, ["--import", "tsx", path.resolve("scripts/restore-finalize.ts")], { ...process.env, DATABASE_URL: options.databaseUrl,
    DATA_DIR: target, LOCAL_STORAGE_DIR: path.join(target, "storage"), STORAGE_DRIVER: "local", RESTORE_FINALIZE: "true" }, "恢复迁移与删除重放");
  return { directory: target, files: manifest.files.length, deletionEntries: parseDeletionLog(merged).length };
}
