"use client";

import { useActionState } from "react";
import { updateBudgetAction } from "@/app/actions/admin";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import { Input } from "@/components/ui/form";
import type { AppSettings } from "@/lib/settings";

function Num({ name, label, value, step = "any" }: { name: string; label: string; value: number; step?: string }) {
  return (
    <label className="block text-xs text-muted">
      {label}
      <Input name={name} type="number" step={step} min={0} defaultValue={value} className="mt-1 h-9" />
    </label>
  );
}

export function BudgetForm({ settings }: { settings: AppSettings }) {
  const [state, action, pending] = useActionState(updateBudgetAction, null);
  const p = settings.pricing;
  return (
    <form action={action} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Num name="monthlyYuan" label="月度 AI 预算（元）" value={settings.budget.monthlyYuan} />
        <Num name="dailyMinutes" label="每账号每日额度（分钟）" value={settings.limits.dailyMinutes} />
        <Num name="maxActiveSessions" label="全站同时进行的面试上限" value={settings.limits.maxActiveSessions} step="1" />
        <Num name="abandonMinutes" label="无活动多久视为放弃（分钟）" value={settings.limits.abandonMinutes} step="1" />
      </div>
      <p className="text-xs font-medium">单价（默认值见附录 D，以控制台为准）</p>
      <div className="grid grid-cols-2 gap-3">
        <Num name="asrPerSecond" label="ASR 元/秒" value={p.asrPerSecond} />
        <Num name="ttsPer10kChars" label="TTS 元/万字符" value={p.ttsPer10kChars} />
        <Num name="llmInputPerMTok" label="LLM 输入 元/百万 token" value={p.llmInputPerMTok} />
        <Num name="llmOutputPerMTok" label="LLM 输出 元/百万 token" value={p.llmOutputPerMTok} />
        <Num name="omniInputPerMTok" label="Omni 输入 元/百万 token" value={p.omniInputPerMTok} />
        <Num name="omniOutputPerMTok" label="Omni 输出 元/百万 token" value={p.omniOutputPerMTok} />
      </div>
      {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {state?.ok ? <Alert tone="success">{state.ok}</Alert> : null}
      <Button type="submit" disabled={pending}>
        保存
      </Button>
    </form>
  );
}
