"use server";

import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { user } from "@/db/schema";
import { getAuth, verifyUserPassword } from "@/lib/auth";
import { getCurrentUser } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { deleteUserAccount } from "@/lib/services/deletion";
import { grantRecordingConsent, withdrawRecordingConsent } from "@/lib/services/recording-consent";

export type FormState = { error?: string; ok?: string } | null;

const passwordRule = z
  .string()
  .min(8, "新密码至少 8 位")
  .max(128, "新密码过长")
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), "新密码需同时包含字母和数字");

/** 修改密码（首次登录强制修改；管理员重置后再次要求修改） */
export async function changePasswordAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const u = await getCurrentUser();
  if (!u) redirect("/login");
  const current = String(fd.get("currentPassword") ?? "");
  const next = String(fd.get("newPassword") ?? "");
  const confirm = String(fd.get("confirmPassword") ?? "");
  const parsed = passwordRule.safeParse(next);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  if (next !== confirm) return { error: "两次输入的新密码不一致" };
  if (next === current) return { error: "新密码不能与当前密码相同" };
  try {
    await getAuth().api.changePassword({
      body: { currentPassword: current, newPassword: next, revokeOtherSessions: true },
      headers: await headers(),
    });
  } catch {
    return { error: "当前密码不正确" };
  }
  await db.update(user).set({ mustChangePassword: false, updatedAt: new Date() }).where(eq(user.id, u.id));
  redirect(u.onboardedAt ? "/" : "/onboarding");
}

const onboardingSchema = z.object({
  targetBand: z.enum(["5.5", "6", "6.5", "7", "7.5", "8+"]),
  selfLevel: z.enum(["beginner", "intermediate", "advanced"]),
  consent: z.literal("on", { message: "请阅读并勾选同意录音与数据处理说明" }),
});

/** 入门设置：目标分数、自评基础、录音告知与同意 */
export async function onboardingAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const u = await getCurrentUser();
  if (!u) redirect("/login");
  const parsed = onboardingSchema.safeParse({
    targetBand: fd.get("targetBand"),
    selfLevel: fd.get("selfLevel"),
    consent: fd.get("consent"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  await grantRecordingConsent(u.id, parsed.data);
  redirect("/device-check?next=/welcome");
}

const settingsSchema = z.object({
  targetBand: z.enum(["5.5", "6", "6.5", "7", "7.5", "8+"]),
  subtitlePref: z.enum(["auto", "always", "never"]),
  allowAdminView: z.boolean(),
});

export async function updateSettingsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const u = await getCurrentUser();
  if (!u) redirect("/login");
  const parsed = settingsSchema.safeParse({
    targetBand: fd.get("targetBand"),
    subtitlePref: fd.get("subtitlePref"),
    allowAdminView: fd.get("allowAdminView") === "on",
  });
  if (!parsed.success) return { error: "设置内容无效" };
  await db.update(user).set({ ...parsed.data, updatedAt: new Date() }).where(eq(user.id, u.id));
  return { ok: "设置已保存" };
}

/** 撤回录音同意：之后不能再录音，已有记录不受影响 */
export async function withdrawConsentAction() {
  const u = await getCurrentUser();
  if (!u) redirect("/login");
  return { userId: u.id, ...await withdrawRecordingConsent(u.id) };
}

/** 删除账号：验证密码后立即停用并撤销登录，后台删除全部录音与记录 */
export async function deleteAccountAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const u = await getCurrentUser();
  if (!u) redirect("/login");
  if (u.isAdmin) return { error: "管理员账号不能在此删除，请先在管理页转移管理员身份" };
  const pw = String(fd.get("password") ?? "");
  if (String(fd.get("confirmText") ?? "") !== "删除我的账号") return { error: "请输入“删除我的账号”以确认" };
  if (!(await verifyUserPassword(u.id, pw))) return { error: "密码不正确" };
  await deleteUserAccount(u.id, u.id);
  redirect("/login");
}

export async function signOutAction() {
  await getAuth().api.signOut({ headers: await headers() });
  redirect("/login");
}
