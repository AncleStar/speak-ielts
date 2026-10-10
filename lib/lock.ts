import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "@/lib/env";

const state = globalThis as unknown as { __lockPool?: pg.Pool };
const scope = new AsyncLocalStorage<{ keys: Set<string>; active: boolean }>();

/** PostgreSQL advisory lock shared by web/worker processes; always released. */
export async function withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  return withLocks([key], operation);
}
/** Acquire combined admission locks on one connection, in a fixed order; nested pool acquisition can deadlock. */
export async function withLocks<T>(keys: string[], operation: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(keys)].sort(), parent = scope.getStore();
  if (parent?.active) {
    if (!ordered.every(key => parent.keys.has(key))) throw new Error("Nested advisory locks must be declared together in the outer withLocks call");
    return operation();
  }
  // 单独连接池：等待同一把锁的请求不能耗尽执行业务 SQL 的连接。
  if (!state.__lockPool) { state.__lockPool = new pg.Pool({ connectionString: env().DATABASE_URL, max: 4, idleTimeoutMillis: 10000 }); state.__lockPool.on("error", () => console.error("[lock] 数据库锁连接异常")); }
  const client = await state.__lockPool.connect();
  const acquired: string[] = [];
  const context = { keys: new Set(ordered), active: true }; let discard = false;
  const disconnected = () => { discard = true; }; client.on("error", disconnected);
  try {
    for (const key of ordered) { await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [key]); acquired.push(key); }
    return await scope.run(context, operation);
  } finally {
    context.active = false;
    for (const key of acquired.reverse()) await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]).catch(() => { discard = true; });
    client.removeListener("error", disconnected); client.release(discard);
  }
}
