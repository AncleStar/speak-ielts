import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { account, signupInvite, signupLimit, user } from "@/db/schema";
import { getAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { AppError, badRequest } from "@/lib/errors";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export async function createInvite(actorId: string, email: string | null, days: number) {
  const code = randomBytes(18).toString("base64url");
  const [row] = await db.insert(signupInvite).values({ codeHash: digest(code), email: email?.trim().toLowerCase() || null,
    createdBy: actorId, expiresAt: new Date(Date.now() + days * 86400000) }).returning();
  return { id: row.id, code, expiresAt: row.expiresAt };
}
export async function listInvites() {
  return db.select({ id: signupInvite.id, email: signupInvite.email, expiresAt: signupInvite.expiresAt,
    usedAt: signupInvite.usedAt, revokedAt: signupInvite.revokedAt, createdAt: signupInvite.createdAt })
    .from(signupInvite).orderBy(desc(signupInvite.createdAt)).limit(100);
}
export async function revokeInvite(id: string) {
  await db.update(signupInvite).set({ revokedAt: new Date() }).where(eq(signupInvite.id, id));
}
/** A shared limit cannot be bypassed by forging proxy IP headers. */
export async function limitSignup(email: string, code: string) {
  const now = new Date();
  await db.delete(signupLimit).where(lt(signupLimit.expiresAt, now));
  for (const [key, max] of [["global", 100], [digest(`email:${email.toLowerCase()}`), 8], [digest(`code:${code}`), 12]] as const) {
    const [row] = await db.insert(signupLimit).values({ key, count: 1, expiresAt: new Date(now.getTime() + 15 * 60000) })
      .onConflictDoUpdate({ target: signupLimit.key, set: { count: sql`${signupLimit.count} + 1` } }).returning();
    if (row.count > max) throw new AppError(429, "signup_rate", "注册尝试过多，请 15 分钟后再试");
  }
}
export async function registerWithInvite(input: { email: string; name: string; password: string; code: string }) {
  const email = input.email.trim().toLowerCase();
  const code = input.code.trim();
  await limitSignup(email, code);
  // Hashing happens before taking the row lock. User, credential and invite commit together.
  const ctx = await getAuth().$context;
  const password = await ctx.password.hash(input.password);
  return db.transaction(async tx => {
    const [invite] = await tx.select().from(signupInvite).where(eq(signupInvite.codeHash, digest(code))).for("update");
    if (!invite || invite.usedAt || invite.revokedAt || invite.expiresAt <= new Date() || (invite.email && invite.email !== email)) {
      throw badRequest("邀请码不可用，请核对邀请码、受邀邮箱或联系管理员领取新的邀请码", "invalid_invite");
    }
    const id = randomUUID();
    const rows = await tx.insert(user).values({ id, name: input.name.trim(), email, role: "user", mustChangePassword: false })
      .onConflictDoNothing({ target: user.email }).returning({ id: user.id });
    if (!rows.length) throw badRequest("该邮箱无法注册。如果已有账号，请返回登录或联系管理员恢复密码", "email_unavailable");
    await tx.insert(account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password });
    await tx.update(signupInvite).set({ usedAt: new Date(), usedBy: id }).where(and(eq(signupInvite.id, invite.id)));
    return { ok: true };
  });
}
