"use client";

import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, Pencil, RotateCcw, Star, XCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { StartSessionButton } from "@/components/start-session-button";
import { ReferenceAudio } from "./reference-audio";
import { RecordPlayer } from "./record-player";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import { Checkbox, Textarea } from "@/components/ui/form";
import { ApiError, api } from "@/lib/client/api";
import { DIMENSION_LABEL, PRONUNCIATION_NOT_ASSESSED, type StoredFeedback } from "@/lib/feedback/schema";
import { ANSWER_STATUS_LABEL, cn, formatDate, formatDuration, INSUFFICIENT_LABEL } from "@/lib/utils";

export interface AnswerView {
  id: string;
  questionId: string;
  kind: string;
  promptText: string;
  attempt: number;
  status: string;
  durationMs: number | null;
  limitSeconds: number | null;
  metrics: unknown;
  transcript: string | null;
  transcriptMock?: boolean | null;
  processingStage?: string | null;
  questionVersionId?: string;
  correctedTranscript: string | null;
  insufficientReason: string | null;
  error: string | null;
  interrupted: boolean;
  hasAudio: boolean;
  audioExpiresAt: string | null;
  createdAt: string | Date;
}

export interface FeedbackView {
  data: StoredFeedback;
  goalMet: boolean;
  goalReason: string;
  basedOnCorrection: boolean;
  mock: boolean;
  model: string;
}

type Metrics = { durationSec?: number; speechSec?: number; pauseCount?: number; longestPauseSec?: number; wordsPerMinute?: number | null };

export function MetricsRow({ answer }: { answer: AnswerView }) {
  const m = (answer.metrics ?? {}) as Metrics;
  const items = [
    ["回答时长", formatDuration(m.durationSec ?? (answer.durationMs ? answer.durationMs / 1000 : null))],
    ["有效语音", formatDuration(m.speechSec)],
    ["停顿（>1 秒）", m.pauseCount !== undefined ? `${m.pauseCount} 次` : "—"],
    ["最长停顿", m.longestPauseSec !== undefined ? `${m.longestPauseSec} 秒` : "—"],
    ["每分钟词数", answer.transcriptMock === false && m.wordsPerMinute ? `${m.wordsPerMinute}` : "未评估"],
  ];
  return (
    <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5" data-testid="metrics">
      {items.map(([k, v]) => (
        <div key={k} className="rounded-lg bg-slate-50 px-2.5 py-1.5">
          <dt className="text-xs text-muted">{k}</dt>
          <dd className="font-medium tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function FeedbackBlock({ fb, compact }: { fb: FeedbackView; compact?: boolean }) {
  const d = fb.data;
  return (
    <div className="space-y-3" data-testid="feedback">
      <div className="flex flex-wrap items-center gap-2">
        {fb.mock ? <Badge tone="muted">演示结果，不计入能力进步</Badge> : fb.goalMet ? (
          <Badge tone="success">
            <CheckCircle2 className="h-3.5 w-3.5" /> 本题目标达成
          </Badge>
        ) : (
          <Badge tone="warning">
            <XCircle className="h-3.5 w-3.5" /> 本题目标未达成
          </Badge>
        )}
        {fb.basedOnCorrection ? <Badge tone="brand">基于修正文本</Badge> : null}
        {fb.mock ? <Badge tone="warning">模拟反馈（演示数据）</Badge> : null}
      </div>
      <p className="text-sm text-slate-700">
        <span className="font-medium">依据：</span>
        {fb.goalReason}
      </p>
      <p className="text-[15px]">{d.summary}</p>
      {d.improvements[0] && <section className="rounded-2xl border border-brand-200 bg-brand-50 p-4 text-sm" aria-label="本次优先改进">
        <p className="eyebrow">ONE THING TO TRY NEXT</p><h3 className="mt-2 text-base font-semibold">{d.improvements[0].issue}</h3>
        <p className="mt-3 text-muted">你的原句：<q>{d.improvements[0].evidence}</q></p>
        <p className="mt-3 font-medium">试着这样说：{d.improvements[0].suggestion}</p>
        <p className="mt-2 text-muted">{d.improvements[0].explanation}</p>
      </section>}
      <p className="flex items-start gap-1.5 rounded-lg bg-brand-50 p-3 text-sm text-brand-800"><Star className="mt-0.5 h-4 w-4 shrink-0" />下次重练目标：{d.nextGoal}</p>
      <details className="rounded-xl border border-line p-3"><summary className="cursor-pointer py-1 text-sm font-medium">展开完整分析与参考回答</summary><div className="mt-4 space-y-4">
      {d.strengths.length ? (
        <div>
          <p className="mb-1 text-sm font-semibold text-emerald-700">做得好的地方</p>
          <ul className="space-y-2">
            {d.strengths.map((s, i) => (
              <li key={i} className="rounded-lg border border-emerald-100 bg-emerald-50/50 p-2.5 text-sm">
                <p>{s.point}</p>
                <p className="mt-1 text-slate-600">
                  你的原话：<q className="italic">{s.evidence}</q>
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {d.improvements.length > 1 ? (
        <div>
          <p className="mb-1 text-sm font-semibold text-amber-800">最值得改善的问题</p>
          <ul className="space-y-2">
            {d.improvements.slice(1).map((s, i) => (
              <li key={i} className="space-y-1 rounded-lg border border-amber-100 bg-amber-50/50 p-2.5 text-sm">
                <p className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="warning">{DIMENSION_LABEL[s.dimension]}</Badge>
                  {s.issue}
                </p>
                <p className="text-slate-600">
                  原句：<q className="italic">{s.evidence}</q>
                </p>
                <p>
                  建议表达：<span className="font-medium text-brand-800">{s.suggestion}</span>
                </p>
                <p className="text-slate-600">{s.explanation}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {!compact ? (
        <>
          <div className="rounded-lg bg-slate-50 p-3 text-sm">
            <p className="mb-1 font-semibold">
              参考回答 <Badge tone="muted">示例，非考场标准答案</Badge>
            </p>
            <p className="whitespace-pre-line leading-relaxed">{d.sampleAnswer}</p>
          </div>
          <div className="text-sm">
            <p className="font-semibold">三个维度的简短诊断</p>
            <ul className="mt-1 space-y-1">
              <li>
                <span className="text-muted">流利与连贯：</span>
                {d.dimensions.fluency_coherence}
              </li>
              <li>
                <span className="text-muted">词汇：</span>
                {d.dimensions.lexical}
              </li>
              <li>
                <span className="text-muted">语法：</span>
                {d.dimensions.grammar}
              </li>
              <li className="text-muted">{PRONUNCIATION_NOT_ASSESSED}</li>
            </ul>
          </div>
        </>
      ) : null}
      </div></details>
      <p className="text-xs leading-5 text-muted">反馈用于练习参考，不是雅思官方评分；语音时长与停顿由音频检测估算，发音未评估。</p>
    </div>
  );
}

export function AnswerCard({
  answer,
  feedback,
  onChanged,
  showActions = true,
  compact,
  recordingOnly = false,
  onPlaybackChange,
  summary,
}: {
  answer: AnswerView;
  feedback: FeedbackView | null;
  onChanged?: () => void;
  showActions?: boolean;
  compact?: boolean;
  recordingOnly?: boolean;
  onPlaybackChange?: (playing: boolean) => void;
  summary?: React.ReactNode;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(answer.correctedTranscript ?? answer.transcript ?? "");
  const [regen, setRegen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const processing = ["created", "uploaded", "queued", "processing"].includes(answer.status);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: "success", text: ok });
      onChanged?.();
      router.refresh();
    } catch (e) {
      setMsg({ tone: "danger", text: e instanceof ApiError ? e.message : "操作失败" });
    }
    setBusy(false);
  }

  return (
    <div className="space-y-3" data-testid="answer-card" data-status={answer.status}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={answer.status === "done" ? "success" : answer.status === "failed" ? "danger" : answer.status === "insufficient" ? "warning" : "muted"}>
          {processing ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {answer.processingStage === "budget_wait" && answer.status === "failed" ? "等待预算恢复" : ANSWER_STATUS_LABEL[answer.status] ?? answer.status}
        </Badge>
        {answer.attempt > 1 ? <Badge>第 {answer.attempt} 次作答</Badge> : null}
        {answer.interrupted ? (
          <Badge tone="warning">
            <AlertTriangle className="h-3 w-3" /> 录音中断
          </Badge>
        ) : null}
        <span className="text-xs text-muted">{answer.hasAudio && answer.audioExpiresAt ? `录音可回放至 ${formatDate(answer.audioExpiresAt)}` : "当前无可回放录音"}</span>
      </div>

      {answer.hasAudio ? <RecordPlayer answerId={answer.id} durationMs={answer.durationMs} onPlaying={onPlaybackChange}/> : <p className="text-sm text-muted">录音已到期或不可用，已保存的转写与报告仍可查看。</p>}
      {!recordingOnly && <MetricsRow answer={answer} />}
      {processing && <p role="status" className="text-sm text-muted">{({ audio: "1 / 3 · 正在检查录音与静音", transcription: "2 / 3 · 正在识别英语作答", feedback: "3 / 3 · 正在核对原句并生成反馈" } as Record<string, string>)[answer.processingStage ?? ""] ?? "录音已提交，正在排队处理"}。可以离开本页，稍后回来查看。</p>}

      {answer.status === "insufficient" ? (
        <Alert tone="warning" title="无法充分评价">
          {INSUFFICIENT_LABEL[answer.insufficientReason ?? ""] ?? "有效内容太少"}。这不代表你的语言水平低——录音过短、噪声或识别失败都可能导致这种情况。请重新作答。
        </Alert>
      ) : null}
      {answer.status === "failed" ? (
        <Alert
          tone={answer.processingStage === "budget_wait" ? "warning" : "danger"}
          title={answer.processingStage === "budget_wait" ? "等待预算恢复" : "处理失败"}
          action={
            <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => api(`/api/answers/${answer.id}/retry`, { method: "POST" }), "已重新提交处理")}>
              <RotateCcw className="h-4 w-4" /> {answer.processingStage === "budget_wait" ? "检查预算并继续" : "重试处理"}
            </Button>
          }
        >
          {answer.error ?? "处理失败，可稍后重试。"} {answer.processingStage !== "budget_wait" && (answer.hasAudio ? "录音可在保留期内回放；处理失败不代表语言水平低。" : "录音当前不可用；处理失败不代表语言水平低。")}
        </Alert>
      ) : null}

      {answer.transcript !== null ? (
        <div className="space-y-1.5 text-sm">
          <div className="flex items-center justify-between">
            <p className="font-semibold">转写{answer.correctedTranscript ? "（原始）" : ""}</p>
            {answer.transcriptMock !== false && <Badge tone="warning">{answer.transcriptMock ? "演示文本，非录音识别" : "来源未验证"}</Badge>}
            {showActions && !editing ? (
              <Button size="sm" variant="ghost" disabled={processing} onClick={() => setEditing(true)} data-testid="edit-transcript">
                <Pencil className="h-3.5 w-3.5" /> 修正转写
              </Button>
            ) : null}
          </div>
          <p className="rounded-lg bg-slate-50 p-2.5 leading-relaxed" data-testid="transcript">
            {answer.transcript || "（没有识别到内容）"}
          </p>
          {answer.correctedTranscript ? (
            <>
              <p className="font-semibold">修正文本</p>
              <p className="rounded-lg bg-brand-50/60 p-2.5 leading-relaxed">{answer.correctedTranscript}</p>
            </>
          ) : null}
          {editing ? (
            <div className="space-y-2 rounded-lg border border-line p-3">
              <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} aria-label="修正文本" />
              <Checkbox label="用修正文本重新生成反馈（原始转写保留；不会影响发音判断）" checked={regen} onChange={(e) => setRegen(e.target.checked)} />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await api(`/api/answers/${answer.id}/correction`, { body: { text, regenerate: regen } });
                      setEditing(false);
                    }, regen ? "已提交，正在基于修正文本重新生成反馈" : "修正文本已保存")
                  }
                >
                  保存
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  取消
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : processing ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> 正在转写与生成反馈，可以先离开，稍后回来查看。
        </p>
      ) : null}

      {recordingOnly && <details className="text-xs text-muted"><summary className="cursor-pointer py-2">查看语音指标（估算）</summary><MetricsRow answer={answer}/></details>}
      {summary}
      {feedback && !recordingOnly ? <FeedbackBlock fb={feedback} compact={compact} /> : null}
      {feedback && showActions && !recordingOnly ? <ReferenceAudio answerId={answer.id} /> : null}

      {msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}

      {showActions ? (
        <div className={cn("flex flex-wrap items-start gap-2 border-t border-line pt-3")}>
          <StartSessionButton input={{ mode: "retry", sourceAnswerId: answer.id }} size={recordingOnly ? "lg" : "sm"} variant={recordingOnly ? "primary" : "secondary"}>
            <RotateCcw className="h-4 w-4" /> {recordingOnly ? "再次录制" : "重新作答"}
          </StartSessionButton>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => api("/api/retry-items", { body: { answerId: answer.id } }), "已加入待重练清单，首页“今日建议”会优先展示")} data-testid="add-retry">
            加入重练
          </Button>
          {!recordingOnly && <Link href={`/answers/${answer.id}`} className="inline-flex h-9 items-center gap-1 px-2 text-sm text-brand-700">
            单题详情与对比 <ExternalLink className="h-3.5 w-3.5" />
          </Link>}
        </div>
      ) : null}
    </div>
  );
}
