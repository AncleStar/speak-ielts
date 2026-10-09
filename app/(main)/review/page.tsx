import Link from "next/link";
import { requireUser } from "@/lib/auth-server";
import { getReviewQueue } from "@/lib/services/reviews";
import { Card, CardContent } from "@/components/ui/card";
import { StartSessionButton } from "@/components/start-session-button";
import { formatDateTime } from "@/lib/utils";
export default async function ReviewPage() {
  const u = await requireUser(); const queue = await getReviewQueue(u.id);
  return <div className="space-y-6"><div><p className="eyebrow">MAKE IT A LITTLE MORE YOURS</p><h1 className="page-title">今日复习</h1><p className="mt-3 text-sm text-muted">题目与个人表达统一安排。系统按 1、3、7、14 天安排下次回顾。</p></div>
    <Card><CardContent className="pt-6"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">个人表达 · {queue.thoughts.due.length} 份待复习</h2><Link href="/thoughts" className="text-sm underline">观点实验室 ↗</Link></div>
      {queue.thoughts.due.length ? <ul className="mt-3 divide-y divide-line">{queue.thoughts.due.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-4 py-5"><div className="min-w-0 flex-1"><p className="font-medium">{item.title}{item.mock && <span className="ml-2 text-xs text-muted">演示素材</span>}</p><p className="mt-2 text-sm text-muted">{item.sourceText}</p><p className="mt-2 text-xs text-muted">先隐藏 Natural 回想，再对照表达并自评。</p></div><Link href={`/thoughts?thought=${item.id}&practice=1`} className="inline-flex min-h-11 items-center text-sm text-brand-700 underline">开始表达复习 →</Link></li>)}</ul> : <p className="mt-5 text-sm text-muted">没有到期的个人表达。可以在观点实验室将 Natural 加入复习。</p>}
      {queue.thoughts.upcoming.length > 0 && <details className="mt-5 text-sm"><summary className="cursor-pointer py-2">接下来的个人表达 · {queue.thoughts.upcoming.length} 份</summary><ul className="divide-y divide-line">{queue.thoughts.upcoming.map(item => <li key={item.id} className="py-4"><Link href={`/thoughts?thought=${item.id}`}>{item.title} ↗</Link><p className="mt-2 text-xs text-muted">{formatDateTime(item.nextDueAt)}</p></li>)}</ul></details>}
    </CardContent></Card>
    <Card><CardContent className="pt-6"><h2 className="font-semibold">今天可以复习 · {queue.due.length} 题</h2>
      {queue.due.length ? <ul className="mt-3 divide-y divide-line">{queue.due.map(item => <li key={item.questionId} className="flex flex-wrap items-center justify-between gap-4 py-5"><div className="min-w-0 flex-1"><p className="font-medium">{item.text}</p><p className="mt-2 text-sm text-muted">{item.reason}</p><Link href={`/answers/${item.sourceAnswerId}`} className="mt-2 inline-flex min-h-11 items-center text-sm text-brand-700 underline">回听上次回答 / 同题对比</Link></div><StartSessionButton input={{ mode: "retry", sourceAnswerId: item.sourceAnswerId }}>开始重练</StartSessionButton></li>)}</ul> : <p className="mt-6 text-sm leading-7 text-muted">今天没有到期的复习。可以去题库练一道题，也可以在报告里把想改进的回答加入重练。</p>}
    </CardContent></Card>
    {queue.upcoming.length > 0 && <Card><CardContent className="pt-6"><h2 className="font-semibold">接下来复习</h2><ul className="mt-3 divide-y divide-line">{queue.upcoming.map(item => <li className="py-4 text-sm" key={item.questionId}><Link href={`/answers/${item.sourceAnswerId}`} className="hover:underline">{item.text}</Link><p className="mt-2 text-xs text-muted">{formatDateTime(item.dueAt)} · {item.reason}</p></li>)}</ul></CardContent></Card>}
    <p className="text-xs leading-6 text-muted">演示反馈不用于判断薄弱项。时间安排只代表复习节奏，不代表记忆力或语言水平；失败、静音、中断的练习不会推进复习间隔。</p>
  </div>;
}
