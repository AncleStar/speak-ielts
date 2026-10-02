import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth-server";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "登录" };

export default async function LoginPage() {
  const u = await getCurrentUser();
  if (u) redirect(u.mustChangePassword ? "/change-password" : "/");
  return <LoginForm />;
}
