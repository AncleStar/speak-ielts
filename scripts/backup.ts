import "./_env";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { dataDir } from "@/lib/env";

const url = new URL(process.env.DATABASE_URL ?? "");
const dir = path.resolve(process.env.BACKUP_DIR ?? "data/backups");
await fs.mkdir(dir, { recursive: true });
const name = `interview-${new Date().toISOString().replace(/[:.]/g, "-")}.dump`;
const target = path.join(dir, name);
const childEnv = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || "5432", PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: url.pathname.slice(1) };
try {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.PG_DUMP_PATH || "pg_dump", ["--format=custom", "--file", `${target}.partial`], { env: childEnv, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.resume();
    child.once("error", () => reject(new Error("无法运行 PostgreSQL 17 的 pg_dump；安装客户端并设置 PG_DUMP_PATH，或使用 docker compose run --rm backup-premigrate sh /ops/backup-once.sh manual。")));
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`备份失败（退出码 ${code}），未产生可恢复备份。`)));
  });
  await fs.rename(`${target}.partial`, target);
  const tombstone = path.join(dataDir(), "deletion-log.jsonl");
  try { await fs.copyFile(tombstone, `${target}.deletion-log.jsonl`); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  console.log(`备份完成：${target}`);
} catch (err) {
  await fs.rm(`${target}.partial`, { force: true });
  throw err;
}
