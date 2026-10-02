"use client";

import { Clock, NotebookPen } from "lucide-react";
import type { PlanItem } from "@/lib/sessions/plan";
import { formatClock } from "@/lib/timing";
import { cn } from "@/lib/utils";

export function CountdownDisplay({
  remainingMs,
  totalMs,
  label,
  note,
  tone = "brand",
}: {
  remainingMs: number;
  totalMs: number;
  label: string;
  note?: string;
  tone?: "brand" | "listening" | "prep";
}) {
  const pct = totalMs > 0 ? Math.max(0, Math.min(100, (remainingMs / totalMs) * 100)) : 0;
  const low = remainingMs <= 10_000;
  const color = tone === "listening" ? "bg-emerald-500" : tone === "prep" ? "bg-amber-500" : "bg-brand-500";
  return (
    <div className="space-y-1.5" data-testid="countdown">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm text-muted">
          <Clock className="h-4 w-4" aria-hidden />
          {label}
        </span>
        <span className={cn("font-mono text-2xl font-semibold tabular-nums", low && "text-red-600")} aria-live="off">
          {formatClock(remainingMs).padStart(5, "0")}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
        <div className={cn("h-full rounded-full transition-[width] duration-200", low ? "bg-red-500" : color)} style={{ width: `${pct}%` }} />
      </div>
      {note ? <p className="text-xs text-muted">{note}</p> : null}
    </div>
  );
}

export function TaskCard({ item }: { item: PlanItem }) {
  if (!item.card) return null;
  return (
    <div className="rounded-xl border-2 border-dashed border-brand-300 bg-white p-4" data-testid="task-card">
      <p className="text-[15px] font-semibold leading-snug">{item.card.title}</p>
      <p className="mt-2 text-sm text-muted">You should say:</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[15px]">
        {item.card.points.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <p className="mt-1 text-[15px]">{item.card.lastPoint}</p>
    </div>
  );
}

export function NotesPad({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <div className="space-y-1">
      <label htmlFor="notes" className="flex items-center gap-1.5 text-sm font-medium">
        <NotebookPen className="h-4 w-4" aria-hidden /> 便签（仅供准备，不作为口语回答参与评价）
      </label>
      <textarea
        id="notes"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        rows={4}
        className="w-full rounded-xl border border-line bg-amber-50/60 px-3 py-2 text-sm outline-none focus:border-amber-400"
        placeholder="关键词、顺序、例子……"
      />
    </div>
  );
}

export function HintPanel({ item, show }: { item: PlanItem; show: { zh: boolean; keywords: boolean; expressions: boolean; structure: boolean } }) {
  const any = show.zh || show.keywords || show.expressions || show.structure;
  if (!any) return null;
  return (
    <div className="space-y-2 rounded-xl bg-slate-50 p-3 text-sm" data-testid="hints">
      {show.zh ? (
        <p>
          <span className="text-muted">中文理解：</span>
          {item.zh}
        </p>
      ) : null}
      {show.keywords && item.keywords.length ? (
        <p className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted">关键词：</span>
          {item.keywords.map((k) => (
            <span key={k} className="rounded-md bg-white px-2 py-0.5 ring-1 ring-line">
              {k}
            </span>
          ))}
        </p>
      ) : null}
      {show.structure ? (
        <p>
          <span className="text-muted">组织思路：</span>
          {item.structure}
        </p>
      ) : null}
      {show.expressions && item.expressions.length ? (
        <div>
          <span className="text-muted">可用表达：</span>
          <ul className="mt-1 list-disc pl-5">
            {item.expressions.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
