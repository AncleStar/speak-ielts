"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { questionVersion, user } from "@/db/schema";
import { createAccount, resetPassword, revokeAllSessions } from "@/lib/auth";
import { requireAdmin } from "@/lib/auth-server";
import { REVIEW_STATUSES } from "@/lib/content/types";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logOps } from "@/lib/ops";
import { QUEUES, enqueue } from "@/lib/queue";
import { setPublished, setReviewStatus } from "@/lib/services/content";
import { deleteUserAccount } from "@/lib/services/deletion";
import { retryFailedTts } from "@/lib/services/tts";
import { getSettings, setSetting } from "@/lib/settings";

export type AdminState = { error?: string; ok?: string } | null;

function fail(e: unknown): AdminState {
  if (e instanceof AppError) return { error: e.message };
  const msg = (e as { body?: { message?: string }; message?: string })?.body?.message ?? (e as Error)?.message ?? "操作失败";
  return { error: msg };
}

const createSchema = z.object({
  name: z.string().trim().min(1, "请填写姓名").max(50),
  email: z.string().trim().email("邮箱格式不正确"),
  password: z.string().min(8, "初始密码至少 8 位").max(128),
  role: z.enum(["user", "admin"]),
  dailyQuotaMinutes: z.string().optional(),
});

/** 创建试用账号（首次登录必须修改初始密码） */
export async function createUserAction(_prev: AdminState, fd: FormData): Promise<AdminState> {
  const admin = await requireAdmin();
  const p = createSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0].message };
  try {
    const u = await createAccount({ email: p.data.email, password: p.data.password, name: p.data.name, role: p.data.role });
    const q = p.data.dailyQuotaMinutes ? Number(p.data.dailyQuotaMinutes) : null;
    await db
      .update(user)
      .set({ mustChangePassword: true, dailyQuotaMinutes: q && q > 0 ? Math.round(q) : null })
      .where(eq(user.id, u.id));
    await logOps("info", "admin", u.id, `管理员 ${admin.email} 创建账号 ${p.data.email}`);
  } catch (e) {
    return fail(e);
  }
  revalidatePath("/admin/users");
  return { ok: `已创建 ${p.data.email}，请把初始密码安全地告知对方` };
}

/** 管理员重置密码（重置后再次要求修改，并退出该用户所有登录） */
export async function resetPasswordAction(_prev: AdminState, fd: FormData): Promise<AdminState> {
  const admin = await requireAdmin();
  const userId = String(fd.get("userId") ?? "");
  const pw = String(fd.get("password") ?? "");
  if (pw.length < 8) return { error: "新密码至少 8 位" };
  try {
    await resetPassword(userId, pw);
    await db.update(user).set({ mustChangePassword: true }).where(eq(user.id, userId));
    await logOps("info", "admin", userId, `管理员 ${admin.email} 重置了密码`);
  } catch (e) {
    return fail(e);
  }
  revalidatePath("/admin/users");
  return { ok: "密码已重置，对方下次登录需修改密码" };
}

export async function setBannedAction(fd: FormData) {
  const admin = await requireAdmin();
  const userId = String(fd.get("userId"));
  const banned = fd.get("banned") === "true";
  if (userId === admin.id) return;
  await db.update(user).set({ banned, banReason: banned ? "admin" : null }).where(eq(user.id, userId));
  if (banned) await revokeAllSessions(userId);
  revalidatePath("/admin/users");
}

export async function setQuotaAction(fd: FormData) {
  await requireAdmin();
  const userId = String(fd.get("userId"));
  const v = String(fd.get("minutes") ?? "").trim();
  const n = v === "" ? null : Math.max(0, Math.round(Number(v)));
  await db.update(user).set({ dailyQuotaMinutes: Number.isFinite(n as number) ? n : null }).where(eq(user.id, userId));
  revalidatePath("/admin/users");
}

export async function deleteUserAction(fd: FormData) {
  const admin = await requireAdmin();
  const userId = String(fd.get("userId"));
  if (userId === admin.id) return;
  await deleteUserAccount(userId, admin.id);
  revalidatePath("/admin/users");
}

// ------------------------------------------------------------
// 题库审核与发布
// ------------------------------------------------------------

export async function setReviewAction(fd: FormData) {
  const admin = await requireAdmin();
  const versionId = String(fd.get("versionId"));
  const status = String(fd.get("status")) as (typeof REVIEW_STATUSES)[number];
  if (!REVIEW_STATUSES.includes(status)) return;
  await setReviewStatus(versionId, status, admin.email, String(fd.get("note") ?? "") || undefined);
  revalidatePath("/admin/questions");
}

export async function setPublishedAction(_prev: AdminState, fd: FormData): Promise<AdminState> {
  await requireAdmin();
  const versionId = String(fd.get("versionId"));
  const published = fd.get("published") === "true";
  try {
    await setPublished(versionId, published);
    if (published) await enqueue(QUEUES.ttsPregen, { versionIds: [versionId] });
  } catch (e) {
    return fail(e);
  }
  revalidatePath("/admin/questions");
  return { ok: published ? "已发布，考官音频正在生成" : "已取消发布" };
}

/** 批量发布：所有审核通过、且为最新版本的题目 */
export async function publishApprovedAction() {
  await requireAdmin();
  const rows = await db.select({ id: questionVersion.id }).from(questionVersion).where(eq(questionVersion.reviewStatus, "approved"));
  for (const r of rows) await setPublished(r.id, true);
  if (rows.length) await enqueue(QUEUES.ttsPregen, { versionIds: rows.map((r) => r.id) });
  revalidatePath("/admin/questions");
}

// ------------------------------------------------------------
// 考官音频、预算与设置
// ------------------------------------------------------------

export async function regenerateTtsAction() {
  await requireAdmin();
  await enqueue(QUEUES.ttsPregen, {});
  await retryFailedTts();
  revalidatePath("/admin/tts");
}

export async function togglePauseAction(fd: FormData) {
  const admin = await requireAdmin();
  const pause = fd.get("pause") === "true";
  await setSetting("pauseNewSessions", pause);
  await logOps("warn", "admin", null, `管理员 ${admin.email} ${pause ? "暂停" : "恢复"}了新会话`);
  revalidatePath("/admin");
}

const num = (v: FormDataEntryValue | null, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
};

export async function updateBudgetAction(_prev: AdminState, fd: FormData): Promise<AdminState> {
  await requireAdmin();
  const s = await getSettings();
  try {
    await setSetting("budget", { monthlyYuan: num(fd.get("monthlyYuan"), s.budget.monthlyYuan) });
    await setSetting("limits", {
      dailyMinutes: num(fd.get("dailyMinutes"), s.limits.dailyMinutes),
      maxActiveSessions: Math.max(1, Math.round(num(fd.get("maxActiveSessions"), s.limits.maxActiveSessions))),
      abandonMinutes: Math.max(5, Math.round(num(fd.get("abandonMinutes"), s.limits.abandonMinutes))),
    });
    await setSetting("pricing", {
      asrPerSecond: num(fd.get("asrPerSecond"), s.pricing.asrPerSecond),
      ttsPer10kChars: num(fd.get("ttsPer10kChars"), s.pricing.ttsPer10kChars),
      llmInputPerMTok: num(fd.get("llmInputPerMTok"), s.pricing.llmInputPerMTok),
      llmOutputPerMTok: num(fd.get("llmOutputPerMTok"), s.pricing.llmOutputPerMTok),
      omniInputPerMTok: num(fd.get("omniInputPerMTok"), s.pricing.omniInputPerMTok),
      omniOutputPerMTok: num(fd.get("omniOutputPerMTok"), s.pricing.omniOutputPerMTok),
    });
  } catch (e) {
    return fail(e);
  }
  revalidatePath("/admin/usage");
  return { ok: "已保存" };
}
