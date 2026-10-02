import type { Metadata } from "next";
import { requireUser } from "@/lib/auth-server";
import { ChangePasswordForm } from "@/components/account/change-password-form";

export const metadata: Metadata = { title: "修改密码" };

export default async function ChangePasswordPage() {
  const u = await requireUser({ allowMustChange: true, allowNotOnboarded: true });
  return <ChangePasswordForm forced={u.mustChangePassword} email={u.email} />;
}
