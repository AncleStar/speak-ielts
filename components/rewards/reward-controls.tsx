"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Gift, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/client/api";

export function RewardButton({ action, disabled, children, answerId, offer }: { action: "checkin" | "redeem" | "review"; disabled?: boolean; children: React.ReactNode; answerId?: string; offer?: { cost: number; minutes: number; days: number } }) {
  const router = useRouter(); const requestId = useRef<string | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [confirming, setConfirming] = useState(false), [purchased, setPurchased] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (confirming) dialog.current?.showModal(); else dialog.current?.close(); }, [confirming]);
  async function run() {
    if (busy) return; setBusy(true); setMessage("");
    requestId.current ??= crypto.randomUUID();
    try {
      const result = await api<{ earned?: number }>("/api/rewards", { body: { action, requestId: requestId.current, answerId, offer } });
      setMessage(action === "checkin" ? `已签到，本次获得 ${result.earned ?? 0} 积分` : action === "redeem" ? "兑换成功，分钟券已放入你的账户" : "已记录复盘，现在可以重练这道题");
      if (action === "redeem") { setPurchased(true); setConfirming(false); }
      router.refresh();
    } catch (e) { setMessage(e instanceof Error ? e.message : "操作失败，请重试"); }
    finally { setBusy(false); }
  }
  return <div><Button onClick={() => action === "redeem" ? setConfirming(true) : run()} disabled={disabled || busy || purchased} data-testid={`reward-${action}`} variant={action === "review" ? "outline" : "primary"}>
    {action === "redeem" ? <Gift size={16} /> : disabled ? <Check size={16} /> : <Sparkles size={16} />}{busy ? "正在处理…" : purchased ? "本次已兑换" : children}
  </Button>{purchased && <Button className="ml-2" variant="outline" disabled={disabled || busy} onClick={() => { requestId.current = null; setPurchased(false); setMessage(""); setConfirming(true); }}>再兑换一张</Button>}
    {message && <p role="status" className="mt-2 text-sm text-brand-700">{message}</p>}
    {action === "redeem" && offer && <dialog ref={dialog} onCancel={() => setConfirming(false)} className="m-auto w-[calc(100%-2rem)] max-w-md rounded-3xl border border-line bg-canvas p-6 text-ink shadow-xl backdrop:bg-slate-950/30" aria-labelledby="redeem-title">
      <h2 id="redeem-title" className="text-xl font-semibold">确认兑换分钟券</h2><p className="mt-4 text-sm leading-8">花费 <b>{offer.cost} 积分</b>，获得 <b>{offer.minutes} 分钟</b>额外录音额度。兑换成功后 <b>{offer.days} 天</b>有效，基础额度用完后自动使用。</p>
      <p className="mt-2 text-xs text-muted">重试同一次兑换不会重复扣分。下次购买请点“再兑换一张”。</p>
      {message && !purchased && <p role="alert" className="mt-3 text-sm">{message}</p>}
      <div className="mt-6 flex flex-wrap gap-3"><Button onClick={run} disabled={busy || purchased} data-testid="confirm-redeem">{busy ? "兑换中…" : `确认花费 ${offer.cost} 积分`}</Button><Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>取消</Button></div>
    </dialog>}
  </div>;
}
