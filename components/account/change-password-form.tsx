"use client";

import { useActionState } from "react";
import { changePasswordAction } from "@/app/actions/account";
import { SignOutButton } from "./sign-out-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/feedback";
import { Field, Input } from "@/components/ui/form";

export function ChangePasswordForm({ forced, email }: { forced: boolean; email: string }) {
  const [state, action, pending] = useActionState(changePasswordAction, null);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">{forced ? "首次登录：请修改初始密码" : "修改密码"}</CardTitle>
        <CardDescription>
          当前账号：{email}。新密码至少 8 位，需同时包含字母和数字；修改后其他设备上的登录会被退出。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-4">
          <input type="text" name="username" autoComplete="username" defaultValue={email} className="hidden" readOnly />
          <Field label="当前密码" htmlFor="currentPassword">
            <Input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required />
          </Field>
          <Field label="新密码" htmlFor="newPassword">
            <Input id="newPassword" name="newPassword" type="password" autoComplete="new-password" required minLength={8} />
          </Field>
          <Field label="确认新密码" htmlFor="confirmPassword">
            <Input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" required minLength={8} />
          </Field>
          {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "正在保存…" : "保存新密码"}
          </Button>
        </form>
        <div className="mt-3"><SignOutButton /></div>
      </CardContent>
    </Card>
  );
}
