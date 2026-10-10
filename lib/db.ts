import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { schema } from "@/db/schema";
import { env } from "@/lib/env";

export type DB = NodePgDatabase<typeof schema> & { $client: pg.Pool };

const globalForDb = globalThis as unknown as { __db?: DB; __pool?: pg.Pool; __lockPool?: pg.Pool };

export function getPool(): pg.Pool {
  if (!globalForDb.__pool) {
    globalForDb.__pool = new pg.Pool({
      connectionString: env().DATABASE_URL,
      max: Number(process.env.DB_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
    });
    globalForDb.__pool.on("error", (err) => {
      console.error("[db] 连接池错误", err.message);
    });
  }
  return globalForDb.__pool;
}

export function getDb(): DB {
  env(); // Recheck restore gates even after this process cached a database connection.
  if (!globalForDb.__db) {
    globalForDb.__db = drizzle(getPool(), { schema }) as DB;
  }
  return globalForDb.__db;
}

/** 便捷代理：`db.select()...` 等价于 `getDb().select()...`，首次使用时才连接。 */
export const db: DB = new Proxy({} as DB, {
  get(_t, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const v = real[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(real) : v;
  },
});

export async function closeDb() {
  if (globalForDb.__lockPool) {
    await globalForDb.__lockPool.end();
    globalForDb.__lockPool = undefined;
  }
  if (globalForDb.__pool) {
    await globalForDb.__pool.end();
    globalForDb.__pool = undefined;
    globalForDb.__db = undefined;
  }
}

export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
