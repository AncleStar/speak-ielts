/**
 * 执行数据库迁移（db/migrations 下由 drizzle-kit 生成、随源码提交的 SQL 文件）。
 * Docker 部署中，迁移前由 compose 的 backup-premigrate 服务先做一次完整备份。
 */
import "./_env";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

export async function runMigrations(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) throw new Error("DATABASE_URL 未配置");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: path.resolve("db/migrations") });
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).includes("migrate");
if (isMain) {
  runMigrations()
    .then(() => {
      console.log("数据库迁移完成");
      process.exit(0);
    })
    .catch((e) => {
      console.error("数据库迁移失败：", e);
      process.exit(1);
    });
}
