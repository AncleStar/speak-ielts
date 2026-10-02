"use client";

import { useActionState } from "react";
import { createUserAction, resetPasswordAction } from "@/app/actions/admin";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/form";

export function CreateUserForm({ defaultQuota }: { defaultQuota: number }) {
  const [state, action, pending] = useActionState(createUserAction, null);
  return (
    <form action={action} className="space-y-3" data-testid="create-user-form">
      <Field label="姓名" htmlFor="cu-name">
        <Input id="cu-name" name="name" required />
      </Field>
      <Field label="邮箱" htmlFor="cu-email">
        <Input id="cu-email" name="email" type="email" required autoComplete="off" />
      </Field>
      <Field label="初始密码" htmlFor="cu-pw" hint="至少 8 位；首次登录后必须修改">
        <Input id="cu-pw" name="password" type="text" required minLength={8} autoComplete="off" />
      </Field>
      <Field label="角色" htmlFor="cu-role">
        <Select id="cu-role" name="role" defaultValue="user">
          <option value="user">试用用户</option>
          <option value="admin">管理员</option>
        </Select>
      </Field>
      <Field label="每日额度（分钟）" htmlFor="cu-quota" hint={`留空使用默认值 ${defaultQuota} 分钟`}>
        <Input id="cu-quota" name="dailyQuotaMinutes" type="number" min={1} />
      </Field>
      {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {state?.ok ? <Alert tone="success">{state.ok}</Alert> : null}
      <Button type="submit" disabled={pending}>
        创建账号
      </Button>
    </form>
  );
}

export function ResetPasswordForm({ userId }: { userId: string }) {
  const [state, action, pending] = useActionState(resetPasswordAction, null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="userId" value={userId} />
      <label className="text-xs text-muted">
        重置为新密码
        <Input name="password" type="text" minLength={8} required className="h-9 w-36" autoComplete="off" />
      </label>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        重置密码
      </Button>
      {state?.error ? <span className="text-xs text-red-700">{state.error}</span> : null}
      {state?.ok ? <span className="text-xs text-emerald-700">{state.ok}</span> : null}
    </form>
  );
}
