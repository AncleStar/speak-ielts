import pg from "pg";
import { env } from "@/lib/env";

const state = globalThis as unknown as { __lockPool?: pg.Pool };

/** PostgreSQL advisory lock shared by web/worker processes; always released. */
export async function withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  return withLocks([key], operation);
}
/** Acquire combined admission locks on one connection, in a fixed order; nested pool acquisition can deadlock. */
export async function withLocks<T>(keys: string[], operation: () => Promise<T>): Promise<T> {
  // 单独连接池：等待同一把锁的请求不能耗尽执行业务 SQL 的连接。
  state.__lockPool ??= new pg.Pool({ connectionString: env().DATABASE_URL, max: 4, idleTimeoutMillis: 10000 });
  const client = await state.__lockPool.connect();
  const acquired: string[] = [];
  try {
    for (const key of [...new Set(keys)].sort()) { await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [key]); acquired.push(key); }
    return await operation();
  } finally {
    for (const key of acquired.reverse()) await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]).catch(() => {});
    client.release();
  }
}
