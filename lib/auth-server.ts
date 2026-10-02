import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { user } from "@/db/schema";
import { getAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";

export type CurrentUser = typeof user.$inferSelect & { isAdmin: boolean };

/** 服务端读取当前登录用户（封禁、已删除的账号视为未登录）。 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const h = await headers();
  const s = await getAuth().api.getSession({ headers: h });
  if (!s) return null;
  const [u] = await db.select().from(user).where(eq(user.id, s.user.id));
  if (!u || u.deletedAt || u.banned) return null;
  return { ...u, isAdmin: u.role === "admin" };
}

/**
 * 页面鉴权（以服务端布局校验为准）：
 * 未登录 → /login；需改密 → /change-password；未完成入门设置 → /onboarding。
 */
export async function requireUser(opts: { allowMustChange?: boolean; allowNotOnboarded?: boolean } = {}) {
  const u = await getCurrentUser();
  if (!u) redirect("/login");
  if (u.mustChangePassword && !opts.allowMustChange) redirect("/change-password");
  if (!u.onboardedAt && !opts.allowNotOnboarded && !u.mustChangePassword) redirect("/onboarding");
  return u;
}

export async function requireAdmin() {
  const u = await requireUser();
  if (!u.isAdmin) redirect("/");
  return u;
}

// ------------------------------------------------------------
// 接口鉴权与错误处理
// ------------------------------------------------------------

export async function apiUser(opts: { admin?: boolean; allowMustChange?: boolean } = {}): Promise<CurrentUser> {
  const u = await getCurrentUser();
  if (!u) throw new AppError(401, "unauthorized", "请先登录");
  if (u.mustChangePassword && !opts.allowMustChange) throw new AppError(403, "must_change_password", "请先修改初始密码");
  if (opts.admin && !u.isAdmin) throw new AppError(404, "not_found", "资源不存在");
  return u;
}

export function serverTimeHeaders() {
  return { "X-Server-Time": String(Date.now()), "Cache-Control": "no-store" };
}

export function json(data: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return NextResponse.json(data, { status: init.status ?? 200, headers: { ...serverTimeHeaders(), ...init.headers } });
}

/** 包装路由处理函数：统一把 AppError 转为 JSON 响应，其余错误记为 500（不回显内部信息）。 */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof AppError) {
        return json({ error: { code: e.code, message: e.message, ...e.extra } }, { status: e.status });
      }
      if (e && typeof e === "object" && "digest" in e && String((e as { digest: unknown }).digest).startsWith("NEXT_")) throw e;
      console.error("[api] 未处理的错误", e);
      return json({ error: { code: "internal", message: "服务器内部错误，请稍后重试" } }, { status: 500 });
    }
  };
}

export async function readJson<T = unknown>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new AppError(400, "bad_json", "请求内容不是有效的 JSON");
  }
}
