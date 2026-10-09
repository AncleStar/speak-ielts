"use client";

import Link from "next/link";
import { useActionState } from "react";
import { deleteAccountAction, updateSettingsAction } from "@/app/actions/account";
import { WithdrawConsentButton } from "./withdraw-consent-button";
import { SignOutButton } from "./sign-out-button";
import { ConsentNotice } from "@/components/account/consent-notice";
import { BANDS } from "@/components/account/onboarding-form";
import { Button, LinkButton } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/feedback";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { formatDateTime } from "@/lib/utils";

export function SettingsForms({
  mock,
  isAdmin,
  email,
  defaults,
  consentAt,
  dailyMinutes,
}: {
  mock: boolean;
  isAdmin: boolean;
  email: string;
  defaults: { targetBand: string; subtitlePref: string; allowAdminView: boolean };
  consentAt: string | null;
  dailyMinutes: number;
}) {
  const [state, action, pending] = useActionState(updateSettingsAction, null);
  const [delState, delAction, delPending] = useActionState(deleteAccountAction, null);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>练习偏好</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={action} className="space-y-4">
            <Field label="目标分数" htmlFor="targetBand" hint="只用于调整推荐顺序">
              <Select id="targetBand" name="targetBand" defaultValue={defaults.targetBand}>
                {BANDS.map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </Select>
            </Field>
            <Field label="问题字幕" htmlFor="subtitlePref" hint="“跟随关卡设置”时，字幕随难度逐步减少；模考中问答字幕默认隐藏">
              <Select id="subtitlePref" name="subtitlePref" defaultValue={defaults.subtitlePref}>
                <option value="auto">跟随关卡设置</option>
                <option value="always">始终显示</option>
                <option value="never">始终隐藏（纯听力）</option>
              </Select>
            </Field>
            <Checkbox name="allowAdminView" defaultChecked={defaults.allowAdminView} label="允许管理员查看我的回答（转写与反馈）用于排查问题" />
            {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
            {state?.ok ? <Alert tone="success">{state.ok}</Alert> : null}
            <Button type="submit" disabled={pending}>
              保存
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>账号</CardTitle>
          <CardDescription>
            {email} · 每日练习额度 {dailyMinutes} 分钟
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <LinkButton href="/change-password" variant="outline">
            修改密码
          </LinkButton>
          <LinkButton href="/device-check" variant="outline">
            设备检查
          </LinkButton>
          <SignOutButton />
          <p className="w-full text-xs text-muted">退出会清除本机未上传录音与草稿。</p>
        </CardContent>
      </Card>

      <Card className="md:col-span-2">
        <CardHeader>
          <CardTitle>录音说明与数据授权</CardTitle>
          <CardDescription>{consentAt ? `你于 ${formatDateTime(consentAt)} 同意了录音与个人信息处理说明。` : "你尚未同意录音说明，暂时不能录音练习。"}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ConsentNotice mock={mock} />
          {consentAt ? (
            <WithdrawConsentButton />
          ) : (
            <Link href="/onboarding" className="text-sm text-brand-700 underline">
              前往同意
            </Link>
          )}
        </CardContent>
      </Card>

      <Card className="border-red-200 md:col-span-2">
        <CardHeader>
          <CardTitle className="text-red-700">删除账号</CardTitle>
          <CardDescription>立即停用账号并退出登录；全部录音、转写、反馈和练习记录将在 24 小时内清理，无法恢复。</CardDescription>
        </CardHeader>
        <CardContent>
          {isAdmin ? (
            <p className="text-sm text-muted">管理员账号不能在此删除。</p>
          ) : (
            <form action={delAction} className="grid gap-3 sm:grid-cols-3">
              <input type="text" name="username" autoComplete="username" defaultValue={email} className="hidden" readOnly />
              <Field label="当前密码" htmlFor="del-pw">
                <Input id="del-pw" name="password" type="password" autoComplete="current-password" required />
              </Field>
              <Field label="输入“删除我的账号”确认" htmlFor="del-confirm">
                <Input id="del-confirm" name="confirmText" required />
              </Field>
              <div className="flex items-end">
                <Button type="submit" variant="danger" disabled={delPending}>
                  永久删除账号
                </Button>
              </div>
              {delState?.error ? <Alert tone="danger" className="sm:col-span-3">{delState.error}</Alert> : null}
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
