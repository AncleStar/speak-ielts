/**
 * 本机开发数据库（无需 Docker）：使用 embedded-postgres 在 data/pg 启动 PostgreSQL。
 * 用法：npm run db:local   （保持运行，Ctrl+C 停止）
 * 连接串：postgres://postgres:postgres@localhost:5433/interview
 */
import "./_env";
import path from "node:path";
import fs from "node:fs";
import EmbeddedPostgres from "embedded-postgres";

const port = Number(process.env.LOCAL_PG_PORT ?? 5433);
const dir = path.resolve(process.env.LOCAL_PG_DIR ?? "data/pg");
const dbName = process.env.LOCAL_PG_DB ?? "interview";

export async function startLocalPostgres(opts: { dir: string; port: number; dbName: string; quiet?: boolean }) {
  const fresh = !fs.existsSync(path.join(opts.dir, "PG_VERSION"));
  const pg = new EmbeddedPostgres({
    databaseDir: opts.dir,
    user: "postgres",
    password: "postgres",
    port: opts.port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: opts.quiet ? () => {} : (m) => process.stdout.write(`[pg] ${m}`),
    onError: (e) => console.error("[pg]", e),
  });
  if (fresh) await pg.initialise();
  await pg.start();
  const client = pg.getPgClient();
  await client.connect();
  const exists = await client.query("select 1 from pg_database where datname = $1", [opts.dbName]);
  await client.end();
  if (exists.rowCount === 0) await pg.createDatabase(opts.dbName);
  return pg;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).includes("local-db");
if (isMain) {
  const pg = await startLocalPostgres({ dir, port, dbName, quiet: true });
  console.log(`本机 PostgreSQL 已启动：postgres://postgres:postgres@localhost:${port}/${dbName}`);
  console.log("按 Ctrl+C 停止。");
  const stop = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  setInterval(() => {}, 1 << 30);
}
