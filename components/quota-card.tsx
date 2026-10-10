import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/feedback";
import type { QuotaStatus } from "@/lib/quota";
import Link from "next/link";

export function QuotaCard({ quota }: { quota: QuotaStatus }) {
  const pct = Math.min(100, quota.ratio * 100);
  const used = Math.round(quota.usedSeconds / 60);
  const limit = Math.round(quota.limitSeconds / 60);
  return (
    <Card>
      <CardContent className="space-y-2 pt-4">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">今日基础额度</span>
          <span className="text-muted" data-testid="quota-text">
            {used} / {limit} 分钟
          </span>
        </div>
        <Progress value={pct} tone={quota.exceeded ? "danger" : quota.warn ? "warning" : "brand"} />
        {(quota.uncoveredSeconds ?? 0) > 0 ? (
          <p className="text-xs text-amber-800" role="status">已有录音还有 {quota.uncoveredSeconds} 秒未覆盖。请兑换分钟券后继续；原录音保留，新练习暂不可开始。</p>
        ) : quota.exceeded ? (
          <p className="text-xs text-red-700">可用额度已用完，基础额度于 UTC+8 零点恢复。也可兑换分钟券继续练习。</p>
        ) : quota.warn ? (
          <p className="text-xs text-amber-800">今日额度已使用 80% 以上，请合理安排练习。</p>
        ) : (
          <p className="text-xs text-muted">额度按录音时长计算；开始练习时会预留本次所需时间，结束后按实际用量结算。</p>
        )}
        <div className="mt-3 flex items-center justify-between border-t border-line pt-3 text-sm"><span>额外可用 <b>{((quota.extraSeconds ?? 0) / 60).toFixed(1)}</b> 分钟</span><Link href="/rewards" className="text-xs text-brand-700 underline">积分兑换</Link></div>
        {!!quota.reservedSeconds && <p className="text-xs text-muted">会话预留约 {Math.ceil(quota.reservedSeconds / 60)} 分钟，结束后释放未使用部分。</p>}
        {quota.nextExpiry && <p className="text-xs text-muted">最近一张券到期：{new Date(quota.nextExpiry).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</p>}
      </CardContent>
    </Card>
  );
}
