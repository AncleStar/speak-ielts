"use client";
import { useEffect, useState } from "react";
import { Eye, EyeOff, ArrowLeft } from "lucide-react";
import { LocalRecording } from "./local-recording";
import { Button } from "@/components/ui/button";
import { Textarea, Label } from "@/components/ui/form";
import { api } from "@/lib/client/api";
import type { ThoughtDetail, PracticeInput } from "@/lib/thoughts/schema";

export function ThoughtPracticePanel({ thought, onClose, onSaved, onBusy, onUnsavedChange }: { thought: ThoughtDetail; onClose: () => void; onSaved: (thought: ThoughtDetail) => void; onBusy: (value: boolean) => void; onUnsavedChange: (value: boolean) => void }) {
  const [reveal, setReveal] = useState(false), [recalledText, setText] = useState(""), [durationSeconds, setDuration] = useState(0);
  const [recording, setRecording] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const [pending, setPending] = useState<PracticeInput | null>(null);
  const ready = durationSeconds >= 1 || recalledText.trim().length >= 3;
  useEffect(() => { onUnsavedChange(!!recalledText.trim() || durationSeconds > 0 || !!pending); }, [recalledText, durationSeconds, pending, onUnsavedChange]);
  useEffect(() => () => onUnsavedChange(false), [onUnsavedChange]);
  function busy(value: boolean) { setRecording(value); onBusy(value); }
  async function save(outcome: PracticeInput["outcome"]) {
    const payload: PracticeInput = pending ?? { action: "practice", revision: thought.revision, requestId: crypto.randomUUID(), outcome, recalledText: recalledText.trim(), durationSeconds };
    setSaving(true); setError(""); setPending(payload); onBusy(true);
    try { const saved = await api<ThoughtDetail>(`/api/thoughts/${thought.id}/review`, { body: payload }); onSaved(saved); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); onBusy(false); }
  }
  return <section className="thought-practice" aria-label="隐藏表达练习">
    <div className="thought-section-heading"><div><p className="eyebrow">RECALL / SAY IT YOUR WAY</p><h2>先用自己的话，说一次。</h2></div><Button variant="ghost" size="sm" disabled={recording || saving} onClick={onClose}><ArrowLeft size={15} />返回编辑</Button></div>
    <blockquote className="thought-original">{thought.sourceText}</blockquote>
    <div className="thought-hidden-answer" data-revealed={reveal}>
      {reveal ? <p lang="en" className="thought-natural-answer">{thought.natural}</p> : <><EyeOff size={28} /><p>Natural 已隐藏</p><span>回想理由与细节，试着组织一段自然的英文回答。</span></>}
    </div>
    <LocalRecording onRecorded={setDuration} onBusy={busy} disabled={saving || !!pending} />
    <Label htmlFor="thought-recall">我的尝试表达（可选，也可直接写下来练习）</Label><Textarea id="thought-recall" value={recalledText} maxLength={2800} rows={4} lang="en" disabled={saving || !!pending} onChange={e => setText(e.target.value)} placeholder="Try expressing the idea in your own words…" />
    <div className="thought-actions"><Button variant="outline" disabled={recording || saving} onClick={() => setReveal(!reveal)}><Eye size={15} />{reveal ? "再次隐藏 Natural" : "显示 Natural，进行对照"}</Button>
      {!pending && <Button disabled={!ready || recording || saving} variant="secondary" onClick={() => void save("practice")}>保存本次练习</Button>}
    </div>
    {thought.review && !pending && <div className="thought-self-review"><p>对照表达后，你觉得这次回想得怎么样？</p><div className="thought-actions"><Button variant="outline" disabled={!ready || !reveal || recording || saving} onClick={() => void save("again")}>还想再练 · 1 天后复习</Button><Button disabled={!ready || !reveal || recording || saving} onClick={() => void save("remembered")}>已想起来 · 安排下次复习</Button></div></div>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {pending && !saving && <Button onClick={() => void save(pending.outcome)}>重试保存本次练习</Button>}
    <p className="thought-note">自评用于安排复习，不生成 IELTS 分数。只保存练习不会推进复习间隔。</p>
  </section>;
}
