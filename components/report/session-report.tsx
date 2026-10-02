"use client";

import { CheckCircle2, Clock, Loader2, Trash2, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { StartSessionButton } from "@/components/start-session-button";
import { Badge, DraftBadge } from "@/components/ui/badge";
import { Button, LinkButton } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/feedback";
import { ApiError, api } from "@/lib/client/api";
import type { getSessionReport } from "@/lib/services/reports";
import { formatDateTime, formatDuration, MODE_LABEL, SESSION_STATUS_LABEL } from "@/lib/utils";
import { AnswerCard, type AnswerView, type FeedbackView } from "./answer-card";

type Report = Awaited<ReturnType<typeof getSessionReport>>;

const KIND_LABEL: Record<string, string> = { main: "", followup: "追问", rounding: "收尾问题" };

export function SessionReport({ initial }: { initial: Report }) {
  const router = useRouter();
  const [report, setReport] = useState<Report>(initial);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setReport(await api<Report>(`/api/sessions/${initial.session.id}/report`));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) router.replace("/history");
    }
  }, [initial.session.id, router]);

  // 处理中时轮询
  useEffect(() => {
    if (report.state !== "processing") return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [report.state, refresh]);

  async function onDelete() {
    if (!confirm("删除本次练习？录音、转写和反馈将一并删除，且无法恢复。")) return;
    setDeleting(true);
    try {
      await api(`/api/sessions/${initial.session.id}`, { method: "DELETE" });
      router.replace("/history");
      router.refresh();
    } catch (e) {
      setDeleting(false);
      setError(e instanceof ApiError ? e.message : "删除失败");
    }
  }

  const { session, plan, summary, items } = report;
  const g = summary.goal;
  const isMock = plan.mode === "mock";
  const parts = isMock ? [1, 2, 3] : [0];

  return (
    <div className="space-y-5" data-testid="session-report" data-state={report.state}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold sm:text-2xl">{plan.title}</h1>
            <Badge tone="brand">{MODE_LABEL[plan.mode]}</Badge>
            <Badge tone={session.status === "completed" ? "success" : session.status === "active" ? "brand" : "warning"}>
              {SESSION_STATUS_LABEL[session.status]}
            </Badge>
            {plan.draft ? <DraftBadge /> : null}
          </div>
          <p className="mt-1 text-sm text-muted">
            {plan.subtitle} · {formatDateTime(session.createdAt)}
            {plan.timeScale !== 1 ? ` · 测试时间倍率 ${plan.timeScale}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {session.status === "active" ? (
            <LinkButton href={`/interview/${session.id}`} data-testid="continue-session">
              继续作答
            </LinkButton>
          ) : null}
          <Button variant="danger-outline" onClick={onDelete} disabled={deleting} data-testid="delete-session">
            <Trash2 className="h-4 w-4" /> {deleting ? "正在删除…" : "删除本次练习"}
          </Button>
        </div>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {report.anyMock ? <Alert tone="warning">本报告的转写与反馈来自模拟服务模式，为演示数据，不代表真实评价。</Alert> : null}
      {session.status === "interrupted" ? (
        <Alert tone="warning" title="本次模考已中断">
          {session.interruptReason === "ended_early" ? "你提前结束了模考。" : "录音或播放出现问题，或页面被关闭。"}已录内容仍可复盘；中断的模考不计为完整完成。
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>本次结果</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3" data-testid="report-status">
            {report.state === "processing" ? (
              <span className="flex items-center gap-2 text-sm text-brand-700">
                <Loader2 className="h-4 w-4 animate-spin" /> 反馈处理中（{summary.pending} 条），可以离开后回来查看
              </span>
            ) : report.state === "partial" ? (
              <span className="text-sm text-amber-800">部分完成：{summary.failed} 条处理失败，可在下方重试</span>
            ) : report.state === "empty" ? (
              <span className="text-sm text-muted">还没有保存的回答</span>
            ) : (
              <span className="flex items-center gap-1.5 text-sm text-emerald-700">
                <CheckCircle2 className="h-4 w-4" /> 全部回答已处理
              </span>
            )}
            <span className="flex items-center gap-1 text-sm text-muted">
              <Clock className="h-4 w-4" /> 作答 {formatDuration(summary.durationSec)} · 有效语音 {formatDuration(summary.speechSec)}
            </span>
          </div>
          {g.applicable ? (
            <div className="rounded-xl bg-slate-50 p-3" data-testid="goal-summary">
              <p className="text-sm">
                <span className="font-medium">本关目标：</span>
                {g.description}
              </p>
              {isMock ? (
                <p className="mt-1 text-sm">{g.met ? "✅ 三个部分完整完成且未中断" : "未完整完成（中断或提前结束）"}</p>
              ) : (
                <>
                  <p className="mt-1 text-sm">
                    达成 {g.metCount} / {g.of} 题（需要 {g.requiredMet} 题）：
                    {g.met === null ? <span className="text-muted">{session.status === "completed" ? "等待全部反馈生成后判断" : "完成全部题目后判断"}</span> : g.met ? <b className="text-emerald-700">目标达成</b> : <b className="text-amber-800">目标未达成</b>}
                  </p>
                  <ul className="mt-2 space-y-1 text-sm">
                    {g.items.map((it) => (
                      <li key={it.index} className="flex items-start gap-1.5">
                        {it.met ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />}
                        <span>
                          第 {it.index + 1} 题：{it.reason}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          ) : null}
          <p className="text-xs text-muted">
            停顿、语速等指标用于观察变化，不换算雅思分数。首版不展示未经校准的雅思总分或单项分；发音显示为“未评估”。
          </p>
        </CardContent>
      </Card>

      {parts.map((p) => (
        <section key={p} className="space-y-3">
          {isMock ? <h2 className="text-lg font-semibold">Part {p}</h2> : null}
          {items
            .filter((it) => !isMock || it.part === p)
            .map((it) => (
              <Card key={it.index} data-testid={`item-${it.index}`}>
                <CardHeader>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    <span>
                      {isMock ? "" : `第 ${it.index + 1} 题 · `}
                      {it.questionId} · {it.topicName}
                    </span>
                    {KIND_LABEL[it.kind] ? <Badge>{KIND_LABEL[it.kind]}</Badge> : null}
                    {it.draft ? <DraftBadge /> : null}
                    {it.skipped && it.attempts.length === 0 ? <Badge tone="warning">已跳过</Badge> : null}
                  </div>
                  <CardTitle className="text-[16px]">{it.prompt}</CardTitle>
                  {it.card ? (
                    <p className="text-xs text-muted">
                      要点：{it.card.points.join(" / ")} / {it.card.lastPoint}
                    </p>
                  ) : null}
                </CardHeader>
                <CardContent className="space-y-5">
                  {it.attempts.length === 0 ? (
                    <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
                      {isMock ? "本题未被提问或未作答（时间用完）。" : "未作答"}
                      {!isMock ? (
                        <StartSessionButton input={{ mode: "practice", questionId: it.questionId }} size="sm" variant="secondary">
                          单题练习
                        </StartSessionButton>
                      ) : null}
                    </div>
                  ) : (
                    [...it.attempts].reverse().map((a, i) => (
                      <div key={a.answer.id} className={i > 0 ? "border-t border-dashed border-line pt-4 opacity-90" : ""}>
                        {i === 1 ? <p className="mb-2 text-xs font-medium text-muted">之前的作答</p> : null}
                        <AnswerCard answer={a.answer as unknown as AnswerView} feedback={a.feedback as FeedbackView | null} onChanged={refresh} compact={i > 0} />
                      </div>
                    ))
                  )}
                  {it.followUps.length ? (
                    <div className="space-y-3 rounded-xl border border-brand-100 bg-brand-50/30 p-3">
                      <p className="text-sm font-semibold text-brand-800">考官追问：{it.followUps.at(-1)!.answer.promptText}</p>
                      {[...it.followUps].reverse().map((a) => (
                        <AnswerCard key={a.answer.id} answer={a.answer as unknown as AnswerView} feedback={a.feedback as FeedbackView | null} onChanged={refresh} />
                      ))}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            ))}
        </section>
      ))}

      {isMock && session.status !== "active" ? (
        <div className="flex flex-wrap gap-2">
          <StartSessionButton input={{ mode: "mock", mockSetId: session.mockSetId ?? undefined }} variant="secondary">
            再做一次这套模考
          </StartSessionButton>
        </div>
      ) : null}
    </div>
  );
}
