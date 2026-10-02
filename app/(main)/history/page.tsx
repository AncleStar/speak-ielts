import type { Metadata } from "next";
import Link from "next/link";
import { DeleteSessionButton } from "@/components/delete-session-button";
import { PageHeader } from "@/components/page-header";
import { Badge, DraftBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/feedback";
import { requireUser } from "@/lib/auth-server";
import type { SessionSummary } from "@/lib/services/outcome";
import { listSessions, totalTrainingSeconds } from "@/lib/services/sessions";
import { cn, formatDateTime, formatDuration, MODE_LABEL, SESSION_STATUS_LABEL } from "@/lib/utils";

export const metadata: Metadata = { title: "学习记录" };

const FILTERS = [
  { key: "", label: "全部" },
  { key: "level", label: "闯关训练" },
  { key: "mock", label: "完整模考" },
  { key: "practice", label: "自由练习" },
  { key: "retry", label: "重练" },
];

export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ mode?: string; page?: string }> }) {
  const u = await requireUser();
  const sp = await searchParams;
  const mode = FILTERS.some((f) => f.key === sp.mode) ? sp.mode : undefined;
  const page = Math.max(0, Number(sp.page ?? 0) || 0);
  const [sessions, total] = await Promise.all([listSessions(u.id, { mode: mode || undefined, limit: 30, offset: page * 30 }), totalTrainingSeconds(u.id)]);

  return (
    <>
      <PageHeader title="我的记录盘" description={`累计作答时长 ${formatDuration(total)}。原始录音保存 30 天，文本报告保留到你删除为止。`} />
      <div className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={f.key ? `/history?mode=${f.key}` : "/history"}
            className={cn("rounded-full px-3 py-1 text-sm", (mode ?? "") === f.key ? "bg-brand-50 text-brand-700 ring-1 ring-brand-200" : "bg-white ring-1 ring-line")}
          >
            {f.label}
          </Link>
        ))}
      </div>
      {sessions.length === 0 ? (
        <EmptyState title="暂无记录" />
      ) : (
        <ul className="record-shelf" data-testid="history-list">
          {sessions.map((s) => {
            const r = s.report as SessionSummary | null;
            return (
              <li key={s.id} className="record-shelf-item" data-testid={`history-${s.id}`}>
                <Link href={s.status === "active" ? `/interview/${s.id}` : `/sessions/${s.id}`} className="record-disc-artwork" aria-label={`打开记录盘 ${s.title}`}>
                  <img src="/models/rhine/record-disc.webp" alt="" width="900" height="900" loading="lazy" />
                  <span><i data-active={s.status==="active"}/>{s.status==="active"?"IN PROGRESS":"PERSONAL RECORD"}</span>
                </Link>
                <Link href={s.status === "active" ? `/interview/${s.id}` : `/sessions/${s.id}`} className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="brand">{MODE_LABEL[s.mode]}</Badge>
                    <Badge tone={s.status === "completed" ? "success" : s.status === "active" ? "brand" : "warning"}>{SESSION_STATUS_LABEL[s.status]}</Badge>
                    {r?.goal.met === true ? <Badge tone="success">目标达成</Badge> : null}
                    {r && r.pending > 0 ? <Badge tone="muted">反馈处理中</Badge> : null}
                    {s.draft ? <DraftBadge /> : null}
                  </span>
                  <span className="truncate text-[15px] font-medium">{s.title}</span>
                  <span className="text-xs text-muted">REC-{s.id.slice(0,8).toUpperCase()}</span>
                  <span className="text-xs text-muted">
                    {formatDateTime(s.createdAt)} · {s.answerCount} 段回答 · {formatDuration(s.durationMs / 1000)}
                  </span>
                </Link>
                <DeleteSessionButton id={s.id} />
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-4 flex gap-3 text-sm">
        {page > 0 ? <Link href={`/history?${mode ? `mode=${mode}&` : ""}page=${page - 1}`}>上一页</Link> : null}
        {sessions.length === 30 ? <Link href={`/history?${mode ? `mode=${mode}&` : ""}page=${page + 1}`}>下一页</Link> : null}
      </div>
    </>
  );
}
