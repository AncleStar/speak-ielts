"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/form";
import { formatDateTime } from "@/lib/utils";
import { AnswerCard, type AnswerView, type FeedbackView } from "./answer-card";

export interface HistoryEntry {
  answer: AnswerView;
  feedback: FeedbackView | null;
  sessionTitle: string;
  mode: string;
  goalRule?: string;
  minEffectiveSeconds?: number | null;
  timeScale?: number;
}

/** 同题历次作答并排对比（重练保留原始回答和新回答） */
export function AttemptCompare({ entries, currentId }: { entries: HistoryEntry[]; currentId: string }) {
  const [left, setLeft] = useState(entries.at(-1)?.answer.id);
  const [right, setRight] = useState(entries.find(e => e.answer.id === currentId && e.answer.id !== entries.at(-1)?.answer.id)?.answer.id ?? entries[0]?.answer.id);
  if (entries.length < 2) return <p className="text-sm text-muted">这道题目前只有一次作答。重新作答后可以在这里并排对比。</p>;
  const pick = (id: string | undefined) => entries.find((e) => e.answer.id === id);
  const label = (e: HistoryEntry) => `${formatDateTime(e.answer.createdAt)} · ${e.sessionTitle}`;
  const a = pick(left), b = pick(right);
  const comparable = a && b && a.answer.status === "done" && b.answer.status === "done" && a.answer.transcriptMock === false && b.answer.transcriptMock === false && a.feedback && b.feedback && !a.feedback.mock && !b.feedback.mock && a.answer.questionVersionId === b.answer.questionVersionId && !a.feedback.basedOnCorrection && !b.feedback.basedOnCorrection
    && a.timeScale === 1 && b.timeScale === 1 && !!a.goalRule && a.goalRule === b.goalRule && a.minEffectiveSeconds === b.minEffectiveSeconds && a.answer.limitSeconds === b.answer.limitSeconds && a.answer.promptText === b.answer.promptText;
  return (
    <div className="space-y-3" data-testid="compare">
      <div className="rounded-xl bg-brand-50 p-4 text-sm leading-7">
        {comparable ? <>左侧目标：{a.feedback!.goalMet ? "达成" : "待练习"} → 右侧目标：{b.feedback!.goalMet ? "达成" : "待练习"}。<br />对照两次原话与具体建议，留意这次是否做到了上次的重练目标。单题变化不等于雅思分数变化。</> : <>目前仅供回听与文本对照。演示反馈、修正文本、不同版本/训练条件或未完成处理的记录，不生成能力变化结论。</>}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {[
          [left, setLeft],
          [right, setRight],
        ].map(([val, set], i) => {
          const e = pick(val as string);
          return (
            <div key={i} className="space-y-3 rounded-2xl border border-line bg-white p-4">
              <Select value={val as string} onChange={(ev) => (set as (v: string) => void)(ev.target.value)} aria-label={i === 0 ? "左侧作答" : "右侧作答"}>
                {entries.map((x) => (
                  <option key={x.answer.id} value={x.answer.id} disabled={x.answer.id === (i === 0 ? right : left)}>
                    {label(x)}
                  </option>
                ))}
              </Select>
              {e ? (
                <>
                  <p className="text-xs text-muted">{e.feedback?.data.nextGoal ? `本次练习目标：${e.feedback.data.nextGoal}` : "尚无可对比反馈"}</p>
                  {e.feedback && !e.feedback.mock ? <Badge tone={e.feedback.goalMet ? "success" : "warning"}>{e.feedback.goalMet ? "目标达成" : "目标未达成"}</Badge> : null}
                  <AnswerCard answer={e.answer} feedback={e.feedback} showActions={false} compact />
                </>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
