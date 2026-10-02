"use client";
import { useEffect, useRef, useState } from "react";
import { Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/client/api";
import { ExaminerAudio } from "@/lib/client/examiner-audio";

export function ReferenceAudio({ answerId }: { answerId: string }) {
  const player = useRef<ExaminerAudio | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  useEffect(() => { player.current = new ExaminerAudio(); return () => player.current?.dispose(); }, []);
  async function play() {
    setBusy(true); setError("");
    try {
      await player.current!.unlock();
      const { ttsId } = await api<{ ttsId: string }>(`/api/answers/${answerId}/reference-audio`, { method: "POST" });
      if (await player.current!.play(ttsId) === "failed") setError("音频仍在准备或暂时不可用，请稍后重试。");
    } catch (e) { setError(e instanceof Error ? e.message : "播放失败，请重试"); }
    finally { setBusy(false); }
  }
  return <div className="space-y-1"><Button size="sm" variant="outline" onClick={play} disabled={busy}><Volume2 className="h-4 w-4" />{busy ? "正在准备 / 播放…" : "朗读参考回答"}</Button>{error && <p role="status" className="text-xs text-amber-800">{error}</p>}</div>;
}
