"use client";
import { useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, ArrowUpRight, Check } from "lucide-react";
import type { GrowthEvent } from "@/lib/services/growth";
import { SESSION_STATUS_LABEL } from "@/lib/utils";

const labels = { checkin: "签到", practice: "练习", mock: "模考", retry: "重练", review: "复盘", points: "积分", thought: "观点练习", thought_review: "表达复习" };
export function GrowthCalendar({ month, today, events }: { month: string; today: string; events: GrowthEvent[] }) {
  const [selection, setSelection] = useState(today.startsWith(month) ? today : `${month}-01`);
  const date = new Date(`${month}-01T12:00:00Z`), count = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  const blanks = (date.getUTCDay() + 6) % 7;
  const changeMonth = (delta: number) => { const d = new Date(date); d.setUTCMonth(d.getUTCMonth() + delta); return `/growth?month=${d.toISOString().slice(0, 7)}`; };
  const selected = events.filter(e => e.day === selection).sort((a,b) => a.at.localeCompare(b.at));
  const earned = selected.reduce((n,e) => n + Math.max(0, e.points ?? 0), 0), spent = selected.reduce((n,e) => n + Math.max(0, -(e.points ?? 0)), 0);
  return <div className="grid gap-7 lg:grid-cols-[1.3fr_1fr]">
    <section aria-label="成长月历"><div className="mb-5 flex items-center justify-between"><h2 className="text-lg font-semibold">{date.getUTCFullYear()} 年 {date.getUTCMonth() + 1} 月</h2><div className="flex gap-1"><Link className="icon-control" href={changeMonth(-1)} aria-label="上个月"><ChevronLeft size={18} /></Link><Link className="icon-control text-sm" href="/growth">今天</Link><Link className="icon-control" href={changeMonth(1)} aria-label="下个月"><ChevronRight size={18} /></Link></div></div>
      <div className="grid grid-cols-7 gap-1.5 text-center"><div className="contents text-xs text-muted">{"一二三四五六日".split("").map(d => <span className="pb-3" key={d}>{d}</span>)}</div>
      {Array.from({ length: blanks }, (_, i) => <span key={`blank-${i}`} />)}
      {Array.from({ length: count }, (_, i) => { const day = `${month}-${String(i + 1).padStart(2, "0")}`; const entries = events.filter(e => e.day === day); const practice = entries.some(e => ["practice", "mock", "retry", "thought", "thought_review"].includes(e.type)); const checkin = entries.some(e => e.type === "checkin"); return <button type="button" key={day} onClick={() => setSelection(day)} aria-pressed={selection === day} aria-label={`${day}${day === today ? " 今天" : ""}，${entries.length} 项活动`} className={`calendar-day ${selection === day ? "selected" : ""} ${day === today ? "today" : ""} ${practice ? "practiced" : ""}`}><span>{i + 1}</span><span className="flex h-3 items-center justify-center gap-1" aria-hidden>{practice && <i className="h-1 w-1 rounded-full bg-brand-600" />}{checkin && <Check size={10} />}{entries.some(e => ["review", "thought_review"].includes(e.type)) && <i className="h-1 w-1 rounded-full bg-amber-600" />}</span></button>; })}</div>
      <p className="mt-4 text-xs text-muted">蓝点：训练与观点练习 · 勾号：签到 · 金点：复盘与表达复习</p>
    </section>
    <section className="rounded-2xl bg-canvas/70 p-5" aria-live="polite"><p className="eyebrow">DAY JOURNAL</p><h2 className="mt-2 text-lg font-semibold">{selection.slice(5).replace("-", " 月 ")} 日的足迹</h2><p className="mt-2 text-xs text-muted">积分获得 +{earned} · 支出 −{spent} · UTC+8</p>
      {selected.length ? <ul className="mt-5 space-y-4">{selected.map((e, i) => <li key={`${e.type}-${i}`} className="border-b border-line pb-4 last:border-0"><p className="text-xs text-brand-700">{new Date(e.at).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" })} · {labels[e.type]}{e.points !== undefined ? ` · ${e.points > 0 ? "+" : ""}${e.points} 分` : ""}{e.status ? ` · ${SESSION_STATUS_LABEL[e.status]}` : ""}{e.seconds ? ` · ${e.selfReported ? "浏览器记录" : "录音"} ${Math.round(e.seconds)} 秒` : e.selfReported ? " · 文本练习" : ""}</p>{e.href ? <Link href={e.href} className="mt-1 flex items-start justify-between gap-2 text-sm font-medium hover:underline">{e.title}<ArrowUpRight className="shrink-0" size={16} /></Link> : <p className="mt-1 text-sm">{e.title}</p>}</li>)}</ul> : <div className="mt-10 text-sm leading-7 text-muted"><p>这一天还没有留下记录。</p><p>一次短练习，也值得被记住。</p><Link href="/practice" className="mt-4 inline-block text-brand-700 underline">去练一道题</Link></div>}
    </section>
  </div>;
}
