"use client";

import { useActionState } from "react";
import { onboardingAction } from "@/app/actions/account";
import { ConsentNotice } from "@/components/account/consent-notice";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/feedback";
import { Checkbox, Field, Select } from "@/components/ui/form";

export const BANDS = ["5.5", "6", "6.5", "7", "7.5", "8+"];

export function OnboardingForm({ mock, defaults, consented }: { mock: boolean; defaults: { targetBand: string; selfLevel: string }; consented: boolean }) {
  const [state, action, pending] = useActionState(onboardingAction, null);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">欢迎！先做两项简单设置</CardTitle>
        <CardDescription>目标分数和自评基础只用于调整推荐顺序，不会据此给出雅思分数。</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="目标分数" htmlFor="targetBand">
              <Select id="targetBand" name="targetBand" defaultValue={defaults.targetBand}>
                {BANDS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="自评基础" htmlFor="selfLevel">
              <Select id="selfLevel" name="selfLevel" defaultValue={defaults.selfLevel}>
                <option value="beginner">入门：开口较难，常需要想很久</option>
                <option value="intermediate">中等：能回答，但不够展开</option>
                <option value="advanced">较好：能展开，想提升质量</option>
              </Select>
            </Field>
          </div>
          <ConsentNotice mock={mock} />
          <Checkbox name="consent" defaultChecked={consented} label="我已阅读并同意上述录音与个人信息处理说明（同意后才能开始录音练习）" />
          {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
          <Button type="submit" className="w-full sm:w-auto" disabled={pending}>
            {pending ? "正在保存…" : "保存并检查麦克风"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
