import type { Metadata } from "next";
import { BudgetForm } from "@/components/admin/budget-form";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/feedback";
import { usageOverview } from "@/lib/services/admin";

export const metadata: Metadata = { title: "管理 · 用量与预算" };

const SERVICE_LABEL: Record<string, string> = { asr: "语音识别", tts: "考官语音", llm: "反馈与追问", omni: "音频诊断（实验）", "recovery-adjustment": "恢复费用补记" };

export default async function AdminUsage() {
  const u = await usageOverview();
  const ratio = u.budget > 0 ? (u.monthCost / u.budget) * 100 : 100;
  return (
    <>
      <PageHeader
        title="用量与预算"
        description="仅统计站点承担的 API 费用，用户个人 Key 单独记账。按音频时长、TTS 字符数和模型 Token 估算成本，以百炼账单为准；不含服务器、存储、域名和流量。"
      />
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>本月 AI 调用成本</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-2xl font-semibold">
              ¥{u.monthCost.toFixed(2)} <span className="text-base font-normal text-muted">/ ¥{u.budget}</span>
            </p>
            <Progress value={ratio} tone={ratio >= 100 ? "danger" : ratio >= 80 ? "warning" : "brand"} />
            <p className="text-muted">预算不足时阻止新练习和新的付费处理调用。已成功上传的录音及已完成的转写会保留；未完成的反馈会暂停，预算恢复后可手动重试。录音仍受原保存期限限制。</p>
            <p>
              本月有效练习 {u.effectiveSessions} 次 · 每次有效练习成本 {u.costPerEffective !== null ? `¥${u.costPerEffective.toFixed(3)}` : "—"} · 今日新会话 {u.sessionsToday}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>按服务</CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1">服务</th>
                  <th>调用</th>
                  <th>用量</th>
                  <th>成本</th>
                </tr>
              </thead>
              <tbody>
                {u.byService.map((s) => {
                  const un = s.units as { seconds: number; chars: number; inputTokens: number; outputTokens: number };
                  const usage = s.service === "recovery-adjustment" ? "核对补记 · 不代表新调用" : s.service === "asr" ? `${Math.round(un.seconds)} 秒` : s.service === "tts" ? `${Math.round(un.chars)} 字符` : `${Math.round(un.inputTokens)} / ${Math.round(un.outputTokens)} token`;
                  return (
                    <tr key={`${s.service}-${s.mock}`} className="border-t border-line">
                      <td className="py-1">
                        {SERVICE_LABEL[s.service] ?? s.service}
                        {s.mock ? "（模拟）" : ""}
                      </td>
                      <td>{s.n}</td>
                      <td>{usage}</td>
                      <td>¥{s.cost.toFixed(3)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>按用户（本月）</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {u.byUser.map((r) => (
                <li key={r.userId ?? "system"} className="flex justify-between gap-2">
                  <span className="truncate">{r.email ?? (r.userId ? "（已删除用户）" : "系统（考官音频）")}</span>
                  <span className="tabular-nums">
                    {Math.round(r.asrSeconds / 60)} 分钟语音 · ¥{r.cost.toFixed(3)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>预算、额度与单价</CardTitle>
          </CardHeader>
          <CardContent>
            <BudgetForm settings={u.settings} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
