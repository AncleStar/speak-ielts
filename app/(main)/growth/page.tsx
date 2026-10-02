import Link from "next/link";
import { requireUser } from "@/lib/auth-server";
import { getGrowth } from "@/lib/services/growth";
import { GrowthCalendar } from "@/components/growth-calendar";
import { Card, CardContent } from "@/components/ui/card";
export default async function GrowthPage({ searchParams }: { searchParams: Promise<{ month?: string; range?: string }> }) {
  const u = await requireUser(), p = await searchParams, d = await getGrowth(u.id, p.month);
  const days = p.range === "7" ? 7 : 30, stats = days === 7 ? d.week : d.monthStats;
  const max = Math.max(60, ...d.dailySeconds.slice(-days).map(x => x.seconds));
  return <div className="space-y-6"><div className="flex flex-wrap items-end justify-between gap-4"><div><p className="eyebrow">YOUR SPEAKING JOURNEY</p><h1 className="page-title">成长日历</h1><p className="mt-2 text-sm text-muted">把每一次开口，连成看得见的进步。</p></div><Link href="/history" className="text-sm text-brand-700 underline">全部学习记录 →</Link></div>
    <Card><CardContent className="pt-6 sm:pt-6"><GrowthCalendar key={d.month} month={d.month} today={d.today} events={d.events} /></CardContent></Card>
    <section><div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-semibold">练习的积累</h2><div className="glass-pill flex text-sm">{[7, 30].map(n => <Link key={n} href={`/growth?month=${d.month}&range=${n}`} aria-current={days === n ? "page" : undefined} className={`rounded-full px-4 py-2 ${days === n ? "bg-ink text-canvas" : "text-muted"}`}>近 {n} 天</Link>)}</div></div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">{[[stats.days, "练习天数", "天"], [Math.round(stats.seconds / 60), "实际录音", "分钟"], [(stats.speechSeconds / 60).toFixed(1), "检测到的语音", "分钟"], [stats.topics, "覆盖话题", "个"], [stats.retries, "完成重练", "次"]].map(([value, label, unit]) => <Card key={label}><CardContent className="pt-5"><p className="text-xs text-muted">{label}</p><p className="mt-3 text-3xl font-semibold tracking-tight">{value}<span className="ml-2 text-xs font-normal text-muted">{unit}</span></p></CardContent></Card>)}</div>
      <Card className="mt-3"><CardContent className="pt-5"><h3 className="text-sm font-medium">每天的录音时长</h3><div className="mt-5 flex h-24 items-end gap-1" role="img" aria-label={`近 ${days} 天录音共 ${Math.round(stats.seconds / 60)} 分钟`}>
        {d.dailySeconds.slice(-days).map(x => <div key={x.day} className="group relative flex h-full flex-1 items-end"><div title={`${x.day}：${x.seconds} 秒`} className="w-full rounded-t-md bg-brand-400/80" style={{ height: `${Math.max(3, x.seconds / max * 100)}%`, opacity: x.seconds ? 1 : 0.2 }} /></div>)}</div><div className="mt-2 flex justify-between text-xs text-muted"><span>{d.dailySeconds.at(-days)?.day.slice(5)}</span><span>今天</span></div><details className="mt-4 text-xs text-muted"><summary className="cursor-pointer py-2">查看每日数值</summary><p className="leading-7">{d.dailySeconds.slice(-days).map(x => `${x.day.slice(5)}：${x.seconds} 秒`).join(" · ")}</p></details></CardContent></Card>
    </section><p className="text-xs leading-6 text-muted">以 UTC+8 自然日记录。统计来自服务器解析的录音，处理中数据稍后更新；签到不计入练习天数。这里展示练习行为，不推算雅思分数。录音通常保留 30 天，过期后仍可查看保留的文字报告；主动删除的练习会从日历和统计移除。</p>
  </div>;
}
