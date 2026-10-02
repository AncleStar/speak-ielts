import pg from "pg";
import { env } from "@/lib/env";

const state = globalThis as unknown as { __lockPool?: pg.Pool };

/** PostgreSQL advisory lock shared by web/worker processes; always released. */
export async function withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  // 单独连接池：等待同一把锁的请求不能耗尽执行业务 SQL 的连接。
  state.__lockPool ??= new pg.Pool({ connectionString: env().DATABASE_URL, max: 4, idleTimeoutMillis: 10000 });
  const client = await state.__lockPool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [key]);
    return await operation();
  } finally {
    await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]).catch(() => {});
    client.release();
  }
}
