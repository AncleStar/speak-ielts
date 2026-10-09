import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { admin } from "better-auth/plugins";
import { account, session, user, verification } from "@/db/schema";
import { getDb } from "@/lib/db";
import { authSecret, env } from "@/lib/env";

function createAuth() {
  const e = env();
  const origins = new Set<string>([e.BETTER_AUTH_URL]);
  if (e.APP_DOMAIN && e.APP_DOMAIN !== "localhost") origins.add(`https://${e.APP_DOMAIN}`);
  for (const o of (process.env.TRUSTED_ORIGINS ?? "").split(",")) if (o.trim()) origins.add(o.trim());
  return betterAuth({
    appName: "雅思口语模拟面试",
    secret: authSecret(),
    baseURL: e.BETTER_AUTH_URL,
    trustedOrigins: [...origins],
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: { user, session, account, verification },
    }),
    emailAndPassword: {
      enabled: true,
      // 通用注册关闭；试用账号由管理员创建或通过单次邀请码注册。
      disableSignUp: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      autoSignIn: false,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 14,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: {
      enabled: e.NODE_ENV === "production",
      window: 60,
      max: 100,
      customRules: { "/sign-in/email": { window: 60, max: 10 } },
    },
    advanced: {
      useSecureCookies: e.BETTER_AUTH_URL.startsWith("https://"),
    },
    plugins: [admin({ defaultRole: "user", adminRoles: ["admin"] }), nextCookies()],
  });
}

export type Auth = ReturnType<typeof createAuth>;

const g = globalThis as unknown as { __auth?: Auth };

/** 惰性创建认证实例（构建阶段不需要数据库连接）。 */
export function getAuth(): Auth {
  env(); // A failed restore must not reopen old login sessions through a cached auth instance.
  if (!g.__auth) g.__auth = createAuth();
  return g.__auth;
}

/** 服务端创建账号（不经过公开注册）。 */
export async function createAccount(input: { email: string; password: string; name: string; role?: "user" | "admin" }) {
  const auth = getAuth();
  const res = await auth.api.createUser({
    body: { email: input.email.toLowerCase(), password: input.password, name: input.name, role: input.role ?? "user" },
  });
  return res.user;
}

/** 管理员重置密码（重置后要求再次修改），并撤销该用户所有登录会话。 */
export async function resetPassword(userId: string, newPassword: string) {
  const ctx = await getAuth().$context;
  if (newPassword.length < 8) throw new Error("密码至少 8 位");
  const hash = await ctx.password.hash(newPassword);
  const acct = await ctx.internalAdapter.findCredentialAccount(userId);
  if (acct) await ctx.internalAdapter.updatePassword(userId, hash);
  else await ctx.internalAdapter.linkAccount({ userId, providerId: "credential", accountId: userId, password: hash });
  await ctx.internalAdapter.deleteUserSessions(userId);
}

export async function revokeAllSessions(userId: string) {
  const ctx = await getAuth().$context;
  await ctx.internalAdapter.deleteUserSessions(userId);
}

export async function verifyUserPassword(userId: string, password: string): Promise<boolean> {
  const ctx = await getAuth().$context;
  const acct = await ctx.internalAdapter.findCredentialAccount(userId);
  if (!acct?.password) return false;
  return ctx.password.verify({ hash: acct.password, password });
}
