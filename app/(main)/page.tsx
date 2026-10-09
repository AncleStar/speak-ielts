import { ArrowRight, ArrowUpRight, BookOpen, CalendarDays, Check, FlaskConical, Map, Mic, Play, Sparkles, Timer } from "lucide-react";
import Link from "next/link";
import { PendingUploads } from "@/components/pending-uploads";
import { QuotaCard } from "@/components/quota-card";
import { StartSessionButton } from "@/components/start-session-button";
import { RewardButton } from "@/components/rewards/reward-controls";
import { LinkButton } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { requireUser } from "@/lib/auth-server";
import { getHomeData } from "@/lib/services/reports";
import { getRewards } from "@/lib/services/rewards";
import { getGrowth } from "@/lib/services/growth";
import { getReviewQueue } from "@/lib/services/reviews";
import { getMockCatalog } from "@/lib/services/mock-selection";
import { formatDateTime, formatDuration, MODE_LABEL, SESSION_STATUS_LABEL } from "@/lib/utils";

export default async function HomePage() {
  const u = await requireUser();
  const [d, rewards, growth] = await Promise.all([getHomeData(u.id), getRewards(u.id), getGrowth(u.id)]);
  const mocks = await getMockCatalog(u.id);
  const nextMock = mocks.items.find(m => m.id === mocks.recommendedId);
  const review = await getReviewQueue(u.id);
  return <div className="space-y-6 sm:space-y-8">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="eyebrow">A LITTLE MORE CONFIDENT, EVERY DAY</p><h1 className="page-title">你好，{u.name}<span className="ml-2 text-brand-500">.</span></h1><p className="mt-2 text-sm text-muted">今天，也给自己一点开口的勇气。</p></div><Link href="/growth" className="glass-pill flex items-center gap-2 px-4 py-2.5 text-xs"><CalendarDays size={15} />{growth.today.replaceAll("-", " / ")}</Link></div>
    <PendingUploads userId={u.id} />
    <Link href="/review" className="glass-pill flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm"><span>今日复习 · {review.due.length + review.thoughts.due.length ? `${review.due.length} 道题 / ${review.thoughts.due.length} 份个人表达待复习` : "今天没有到期任务"}</span><span className="text-brand-700">查看复习安排 →</span></Link>
    <div className="grid items-stretch gap-4 lg:grid-cols-[1.65fr_1fr]">
      <section className="hero-panel home-training-panel relative min-h-72 overflow-hidden p-6 sm:p-8">
        <div className="home-training-copy relative z-10"><p className="mb-4 flex items-center gap-2 text-xs font-semibold text-brand-700"><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-600" />{d.active ? "CONTINUE YOUR SESSION" : "YOUR NEXT SMALL STEP"}</p><h2 className="max-w-md whitespace-pre-line text-3xl font-semibold leading-snug tracking-tight sm:text-4xl">{d.active ? "接着上次，\n继续开口。" : "从一句话开始，\n离目标更近一点。"}</h2><p className="mt-3 text-sm leading-6 text-muted">{d.active?.title ?? (d.nextLevel ? `下一关 · ${d.nextLevel.id} ${d.nextLevel.title}` : "所有训练关卡已完成，准备一次完整模考吧。")}</p></div>
        <figure className="home-disc-artwork" aria-label="SPEAK 个人训练磁盘"><img src="/models/rhine/record-disc.webp" width="900" height="900" alt="象牙色透明外壳与双光学环的训练磁盘"/><figcaption><span>SPEAK / AUDIO</span><span>PERSONAL ARCHIVE</span></figcaption></figure>
        <div className="relative z-10 mt-6 flex flex-wrap items-center gap-4">{d.active ? <LinkButton href={`/interview/${d.active.id}`} data-testid="continue-active"><Play size={16} />继续练习</LinkButton> : d.nextLevel ? <LinkButton href={`/levels/${d.nextLevel.id}`} data-testid="next-level">进入关卡 <ArrowRight size={16} /></LinkButton> : <LinkButton href="/practice">选择练习 <ArrowRight size={16} /></LinkButton>}<span className="text-xs text-muted">已完成 {d.stats.completed} / {d.stats.total} 关</span></div>
      </section>
      <Card><CardContent className="pt-6 sm:pt-6"><div className="flex items-center justify-between"><p className="flex items-center gap-2 text-sm font-semibold"><Sparkles size={16} className="text-brand-600" /> 每天一点积累</p><Link href="/rewards" className="text-xs text-brand-700">{rewards.points} 积分 ↗</Link></div><p className="mt-5"><strong className="text-4xl font-semibold tracking-tight">{rewards.streak}</strong><span className="ml-2 text-sm text-muted">天连续签到</span></p><div className="my-5 grid grid-cols-7 gap-1.5" aria-label="七天签到进度">{Array.from({ length: 7 }, (_, i) => { const lit = i < (rewards.streak % 7 || (rewards.streak ? 7 : 0)); return <div key={i} className={`flex aspect-square items-center justify-center rounded-full text-xs ${lit ? "bg-brand-600 text-white" : "bg-brand-50 text-brand-700"}`}>{lit ? <Check size={14} /> : i + 1}</div>; })}</div><RewardButton action="checkin" disabled={rewards.checkedIn || !rewards.rules.enabled}>{rewards.checkedIn ? "今日已签到" : `签到领取 ${rewards.rules.checkin} 积分`}</RewardButton><p className="mt-3 text-xs text-muted">每连续 7 天额外 +{rewards.rules.milestone} 积分 · <Link href="/rewards" className="underline">兑换更多练习时间</Link></p></CardContent></Card>
    </div>
    <section><div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-semibold">找到今天的练习节奏</h2><span className="hidden text-xs text-muted sm:block">练习 / 挑战 / 自由探索</span></div><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Link href="/levels" className="feature-card group"><span className="feature-icon"><Map size={21} /></span><ArrowUpRight className="float-right text-muted" size={18} /><h3 className="mt-5 font-semibold">闯关训练</h3><p className="mt-1 text-sm text-muted">6 章 30 关，从热身走向自如表达</p><p className="mt-5 text-xs text-brand-700">按顺序推进 →</p></Link>
      <div className="feature-card"><span className="feature-icon"><Timer size={21} /></span><h3 className="mt-5 font-semibold">完整模考</h3><p className="mb-2 mt-1 text-sm text-muted">12 分 30 秒，体验三个部分的节奏</p>{nextMock && <><p className="mb-3 text-xs text-muted">推荐：{nextMock.title} · {mocks.recommendation}</p><StartSessionButton input={{ mode: "mock", mockSetId: nextMock.id }} size="sm" variant="secondary" testId="start-mock">开始模考 <ArrowRight size={14} /></StartSessionButton></>}<Link href="/mock" className="mt-3 block text-sm text-brand-700 underline">选择试卷与查看练习情况 →</Link></div>
      <Link href="/practice" className="feature-card"><span className="feature-icon"><BookOpen size={21} /></span><ArrowUpRight className="float-right text-muted" size={18} /><h3 className="mt-5 font-semibold">训练磁盘库</h3><p className="mt-1 text-sm text-muted">选一张磁盘，记录今天的英语表达</p><p className="mt-5 text-xs text-brand-700">浏览全部训练磁盘 →</p></Link>
      <Link href="/thoughts" className="feature-card"><span className="feature-icon"><FlaskConical size={21} /></span><ArrowUpRight className="float-right text-muted" size={18} /><h3 className="mt-5 font-semibold">个人观点实验室</h3><p className="mt-1 text-sm text-muted">用中英文记录观点，生成三种表达，收藏词语并复习</p><p className="mt-5 text-xs text-brand-700">开始自由练习 →</p></Link>
    </div></section>
    <div className="grid gap-4 lg:grid-cols-[1.65fr_1fr]"><Card><CardContent className="pt-5"><div className="flex items-center justify-between"><h2 className="font-semibold">这一周的足迹</h2><Link href="/growth" className="text-xs text-brand-700">成长日历 ↗</Link></div><div className="my-6 grid grid-cols-3 divide-x divide-line">{[[growth.week.days, "练习天数"], [Math.round(growth.week.seconds / 60), "录音分钟"], [growth.week.topics, "覆盖话题"]].map(([value, label]) => <div key={label} className="text-center"><p className="text-3xl font-semibold tracking-tight">{value}</p><p className="mt-2 text-xs text-muted">{label}</p></div>)}</div><p className="text-xs text-muted">真实练习记录，慢慢积累。签到不会计入练习时长。</p></CardContent></Card><QuotaCard quota={d.quota} /></div>
    {d.retryList.some(r => r.available) && <Card><CardContent className="pt-5"><h2 className="mb-3 font-semibold">再试一次，会不一样</h2>{d.retryList.filter(r => r.available).slice(0, 2).map(r => <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-3"><p className="min-w-0 flex-1 text-sm">{r.text}</p><StartSessionButton input={{ mode: "retry", sourceAnswerId: r.sourceAnswerId ?? undefined, questionId: r.questionId }} size="sm" variant="outline">重练</StartSessionButton></div>)}</CardContent></Card>}
    <section><div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-semibold">最近记录</h2><Link href="/history" className="text-xs text-brand-700">全部记录 →</Link></div>{d.recent.length ? <ul className="divide-y divide-line">{d.recent.map(s => <li key={s.id}><Link href={s.status === "active" ? `/interview/${s.id}` : `/sessions/${s.id}`} className="flex flex-wrap items-center gap-3 py-4"><span className="rounded-full bg-brand-50 px-3 py-1 text-xs text-brand-700">{MODE_LABEL[s.mode]}</span><span className="min-w-0 flex-1 text-sm font-medium">{s.title}</span><span className="text-xs text-muted">{SESSION_STATUS_LABEL[s.status]} · {formatDuration(s.durationMs / 1000)} · {formatDateTime(s.createdAt)}</span><ArrowUpRight size={15} className="text-muted" /></Link></li>)}</ul> : <div className="rounded-2xl border border-dashed border-line px-5 py-7 text-sm text-muted">还没有练习记录。从第一关「居住与家乡」开始，记录会自动出现在这里。</div>}</section>
  </div>;
}

