import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { StartSessionButton } from "@/components/start-session-button";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { requireUser } from "@/lib/auth-server";
import { getMockCatalog } from "@/lib/services/mock-selection";
import { formatDateTime } from "@/lib/utils";

export const metadata = { title: "选择模考试卷" };
export default async function MockPage() {
  const u = await requireUser();
  const catalog = await getMockCatalog(u.id);
  return <>
    <PageHeader title="完整模考" description="每套包含 Part 1–3，采用 12 分 30 秒练习模板。先推荐未练过的试卷；全部练过后推荐距离上次最久的一套，也可以自行选择。" />
    <p className="mb-5 text-sm text-muted">未开始的会话不算练过；中断或放弃会留下尝试记录，但不计为完整完成。<Link href="/history?mode=mock" className="ml-2 text-brand-700 underline">查看模考记录</Link></p>
    <div className="grid gap-4 md:grid-cols-2">{catalog.items.map(set => <section key={set.id} className="surface-card rounded-3xl border border-line p-5" data-testid={`mock-paper-${set.id}`}>
      <div className="mb-3 flex flex-wrap gap-2">{set.id === catalog.recommendedId && <Badge tone="brand">本次推荐</Badge>}{!set.available && <Badge tone="muted">内容准备中</Badge>}{set.draft && <Badge tone="warning">原创模拟题 · 待人工审核</Badge>}</div>
      <h2 className="text-lg font-semibold">{set.title}</h2><p className="mt-2 text-sm text-muted">{set.topics}</p>
      <p className="mt-4 text-sm">尝试 {set.attempts} 次 · 完整完成 {set.completed} 次</p>
      <p className="mt-1 text-xs text-muted">{set.lastAttempt ? `上次开始：${formatDateTime(set.lastAttempt)}` : "尚未开始练习"}</p>
      {set.id === catalog.recommendedId && <p className="mt-2 text-sm text-brand-700">{catalog.recommendation}</p>}
      <div className="mt-5">{set.activeSessionId ? <LinkButton href={`/interview/${set.activeSessionId}`} variant="secondary">继续这套模考</LinkButton> : <StartSessionButton input={{ mode: "mock", mockSetId: set.id }} disabled={!set.available} testId={`start-${set.id}`}>开始这套模考</StartSessionButton>}</div>
    </section>)}</div>
  </>;
}
