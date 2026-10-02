import Link from "next/link";
import { requireUser } from "@/lib/auth-server";
import { getReviewQueue } from "@/lib/services/reviews";
import { Card, CardContent } from "@/components/ui/card";
import { StartSessionButton } from "@/components/start-session-button";
import { formatDateTime } from "@/lib/utils";
export default async function ReviewPage() {
  const u = await requireUser(); const queue = await getReviewQueue(u.id);
  return <div className="space-y-6"><div><p className="eyebrow">MAKE IT A LITTLE MORE YOURS</p><h1 className="page-title">今日复习</h1><p className="mt-3 text-sm text-muted">先回听，再试一次。完成有效练习后，系统按 1、3、7、14 天安排下次回顾。</p></div>
    <Card><CardContent className="pt-6"><h2 className="font-semibold">今天可以复习 · {queue.due.length} 题</h2>
      {queue.due.length ? <ul className="mt-3 divide-y divide-line">{queue.due.map(item => <li key={item.questionId} className="flex flex-wrap items-center justify-between gap-4 py-5"><div className="min-w-0 flex-1"><p className="font-medium">{item.text}</p><p className="mt-2 text-sm text-muted">{item.reason}</p><Link href={`/answers/${item.sourceAnswerId}`} className="mt-2 inline-flex min-h-11 items-center text-sm text-brand-700 underline">回听上次回答 / 同题对比</Link></div><StartSessionButton input={{ mode: "retry", sourceAnswerId: item.sourceAnswerId }}>开始重练</StartSessionButton></li>)}</ul> : <p className="mt-6 text-sm leading-7 text-muted">今天没有到期的复习。可以去题库练一道题，也可以在报告里把想改进的回答加入重练。</p>}
    </CardContent></Card>
    {queue.upcoming.length > 0 && <Card><CardContent className="pt-6"><h2 className="font-semibold">接下来复习</h2><ul className="mt-3 divide-y divide-line">{queue.upcoming.map(item => <li className="py-4 text-sm" key={item.questionId}><Link href={`/answers/${item.sourceAnswerId}`} className="hover:underline">{item.text}</Link><p className="mt-2 text-xs text-muted">{formatDateTime(item.dueAt)} · {item.reason}</p></li>)}</ul></CardContent></Card>}
    <p className="text-xs leading-6 text-muted">演示反馈不用于判断薄弱项。时间安排只代表复习节奏，不代表记忆力或语言水平；失败、静音、中断的练习不会推进复习间隔。</p>
  </div>;
}
