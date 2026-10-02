"use client";

import { AlertTriangle, CheckCircle2, CloudUpload, LogOut, Mic, RotateCcw, Square } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, DraftBadge } from "@/components/ui/badge";
import { Button, LinkButton } from "@/components/ui/button";
import { Alert, Progress, Spinner } from "@/components/ui/feedback";
import { ApiError, api, randomId, serverNow } from "@/lib/client/api";
import { ExaminerAudio } from "@/lib/client/examiner-audio";
import { deleteRecording, getBlob, isPersistent, listRecordings, purgeExpired, type RecordingMeta } from "@/lib/client/idb";
import { MIC_ERROR_TEXT, MicError, MicRecorder, savedDeviceId, type StopResult } from "@/lib/client/recorder";
import { uploadQueue } from "@/lib/client/uploader";
import { ScreenWakeLock } from "@/lib/client/wake-lock";
import type { getSessionView } from "@/lib/services/sessions";
import type { AnswerKind, PlanItem, PromptAudio, SessionPlan } from "@/lib/sessions/plan";
import { canAskRounding, nextMockStep, p2PrepLimitMs, p2SpeakLimitMs } from "@/lib/timing";
import { cn } from "@/lib/utils";
import { ExaminerAvatar, type ExaminerState } from "./examiner-avatar";
import { CountdownDisplay, HintPanel, NotesPad, TaskCard } from "./parts";
import { Waveform } from "./waveform";
import { DiscScene } from "@/components/disc/disc-scene";
import { useRhine } from "@/components/disc/rhine-provider";

type SessionView = Awaited<ReturnType<typeof getSessionView>>;

type Phase =
  | "loading"
  | "ready"
  | "starting"
  | "running"
  | "finishing"
  | "done"
  | "incomplete"
  | "interrupted"
  | "closed"
  | "exiting"
  | "error";

type Step = "idle" | "speaking" | "prep" | "recording" | "saving" | "between" | "followup_wait" | "audio_failed" | "item_interrupted";

interface ActionDef {
  id: string;
  label: string;
  variant?: "primary" | "secondary" | "outline" | "ghost" | "danger-outline";
  icon?: "stop" | "retry" | "mic";
}

interface TimerDef {
  startLocal: number;
  totalMs: number;
  label: string;
  note?: string;
  tone: "brand" | "listening" | "prep";
}

class Aborted extends Error {}

interface Runtime {
  aborted: boolean;
  recorder: MicRecorder;
  audio: ExaminerAudio;
  wake: ScreenWakeLock;
  waiter: { ids: string[]; resolve: (id: string) => void } | null;
  interruptReject: ((reason: string) => void) | null;
  partDeadline: number | null;
}

const PREFS_SUBTITLE = { auto: null, always: true, never: false } as const;

export function InterviewRoom({ sessionId, subtitlePref, userId }: { sessionId: string; subtitlePref: "auto" | "always" | "never"; userId: string }) {
  const router = useRouter();
  const rhine = useRhine();
  const stopDiscPlayback = rhine?.stopPlayback;
  const exitBusy = useRef(false);
  const exitMock = useRef(false);
  useEffect(()=>()=>stopDiscPlayback?.(),[stopDiscPlayback]);
  const [view, setView] = useState<SessionView | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [step, setStep] = useState<Step>("idle");
  const [examiner, setExaminer] = useState<ExaminerState>("waiting");
  const [itemIndex, setItemIndex] = useState<number | null>(null);
  const [kind, setKind] = useState<AnswerKind>("main");
  const [prompt, setPrompt] = useState<string | null>(null);
  const [audioFailed, setAudioFailed] = useState(false);
  const [timer, setTimer] = useState<TimerDef | null>(null);
  const [partInfo, setPartInfo] = useState<{ part: number; deadline: number; totalMs: number } | null>(null);
  const [actions, setActions] = useState<ActionDef[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [preload, setPreload] = useState<{ done: number; total: number; failed: number } | null>(null);
  const [localPending, setLocalPending] = useState<RecordingMeta[]>([]);
  const [persistent, setPersistent] = useState(true);
  const [wakeLockOk, setWakeLockOk] = useState<boolean | null>(null);
  const [uploadVersion, setUploadVersion] = useState(0);
  const [followUpText, setFollowUpText] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const network = () => setOnline(navigator.onLine);
    const storageLimited = () => setPersistent(false);
    const visibility = () => { if (document.visibilityState === "hidden") rt.current?.recorder.interrupt(); };
    network(); window.addEventListener("online", network); window.addEventListener("offline", network);
    window.addEventListener("recording-storage-limited", storageLimited);
    document.addEventListener("visibilitychange", visibility);
    return () => { window.removeEventListener("online", network); window.removeEventListener("offline", network); window.removeEventListener("recording-storage-limited", storageLimited); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  useEffect(() => { document.documentElement.dataset.recording = String(step === "recording"); return () => { delete document.documentElement.dataset.recording; }; }, [step]);

  const rt = useRef<Runtime | null>(null);
  if (!rt.current) {
    rt.current = {
      aborted: false,
      recorder: new MicRecorder(),
      audio: new ExaminerAudio(),
      wake: new ScreenWakeLock(),
      waiter: null,
      interruptReject: null,
      partDeadline: null,
    };
  }

  // ---------- 通用工具 ----------
  const check = () => {
    if (rt.current!.aborted) throw new Aborted();
  };

  const waitFor = useCallback((defs: ActionDef[]): Promise<string> => {
    return new Promise<string>((resolve) => {
      rt.current!.waiter = { ids: defs.map((d) => d.id), resolve };
      setActions(defs);
    }).then(result=>{check();return result;});
  }, []);

  const cancelWait = () => {
    rt.current!.waiter = null;
    setActions([]);
  };

  const trigger = useCallback((id: string) => {
    const w = rt.current!.waiter;
    if (w && w.ids.includes(id)) {
      rt.current!.waiter = null;
      setActions([]);
      w.resolve(id);
    }
  }, []);

  const sleep = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => (rt.current!.aborted ? reject(new Aborted()) : resolve()), Math.max(0, ms));
      if (rt.current!.aborted) {
        clearTimeout(t);
        reject(new Aborted());
      }
    });

  const partRemaining = () => (rt.current!.partDeadline ? rt.current!.partDeadline - serverNow() : Number.POSITIVE_INFINITY);

  // 计时刷新
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const unsub = uploadQueue.subscribe(() => setUploadVersion((v) => v + 1));
    return () => {
      unsub();
    };
  }, []);

  // ---------- 加载会话、预加载考官音频 ----------
  useEffect(() => {
    const r = rt.current!;
    r.aborted = false;
    let cancelled = false;
    const boot = setTimeout(async () => {
      try {
        await purgeExpired();
        setPersistent(await isPersistent());
        const v = await api<SessionView>(`/api/sessions/${sessionId}`);
        if (cancelled || r.aborted) return;
        setView(v);
        setLocalPending(await listRecordings(sessionId));
        if (v.session.status !== "active") {
          setPhase("closed");
          return;
        }
        if (v.plan.mode === "mock" && Object.keys(v.session.partStarts ?? {}).length > 0) {
          // 模考进行中被刷新或关闭：不能伪装成完整模考
          await api(`/api/sessions/${sessionId}/events`, { body: { eventId: randomId("ev"), type: "interrupt", reason: "reloaded" } }).catch(() => {});
          setPhase("interrupted");
          setMessage("本次模考在进行中被刷新或关闭，已标记为“中断”。已录内容仍可复盘，你可以重新开始一次模考。");
          return;
        }
        const ids = collectTtsIds(v.plan);
        setPreload({ done: 0, total: ids.length, failed: 0 });
        const res = await r.audio.preload(ids, (done, total) => setPreload((p) => ({ done, total, failed: p?.failed ?? 0 })));
        if (cancelled || r.aborted) return;
        setPreload({ done: ids.length, total: ids.length, failed: res.failed.length });
        setPhase("ready");
      } catch (e) {
        if (cancelled || r.aborted) return;
        setError(e instanceof ApiError ? e.message : "加载失败，请刷新页面重试");
        setPhase("error");
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(boot);
      r.aborted = true;
      r.waiter?.resolve("exit");r.waiter = null;
      r.audio.dispose();
      r.recorder.release();
      void r.wake.release();
    };
  }, [sessionId]);

  // 心跳：保持会话活跃
  useEffect(() => {
    if (phase !== "running") return;
    const t = setInterval(() => {
      void api(`/api/sessions/${sessionId}/events`, { body: { eventId: randomId("hb"), type: "heartbeat" } }).catch(() => {});
    }, 60_000);
    return () => clearInterval(t);
  }, [phase, sessionId]);

  // 离开页面前提醒
  useEffect(() => {
    if (phase !== "running" && phase !== "finishing" && phase !== "exiting") return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [phase]);

  // 键盘：Enter / 空格 = 主要操作
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "BUTTON" || t.tagName === "A" || t.isContentEditable)) return;
      const primary = actions[0];
      if (primary) {
        e.preventDefault();
        trigger(primary.id);
      } else if (phase === "ready") {
        e.preventDefault();
        void startInterview();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, phase, trigger]);

  // ---------- 考官播报 ----------
  async function speak(p: PromptAudio | undefined | null, opts: { showText?: boolean; question?: boolean; deadline?: boolean } = {}) {
    if (!p) return "played" as const;
    check();
    setExaminer("speaking");
    setStep("speaking");
    if (opts.question) setPrompt(p.text);
    let timeoutHit = false;
    let deadlineTimer: ReturnType<typeof setInterval> | null = null;
    if (opts.deadline && rt.current!.partDeadline) {
      deadlineTimer = setInterval(() => {
        if (partRemaining() <= 0) {
          timeoutHit = true;
          rt.current!.audio.stop();
        }
      }, 200);
    }
    const r = await rt.current!.audio.play(p.ttsId);
    if (deadlineTimer) clearInterval(deadlineTimer);
    check();
    setExaminer("waiting");
    if (timeoutHit) return "timeout" as const;
    if (r === "failed" && opts.question) {
      // 考官音频播放失败：显示题目文字并允许继续；未进入答题前不扣训练时间
      setAudioFailed(true);
      setStep("audio_failed");
      const continueReading = waitFor([{ id: "continue", label: "我已看完题目，开始" }]);
      if (opts.deadline) {
        await Promise.race([continueReading, sleep(Math.max(0, partRemaining()))]);
        cancelWait();
        if (partRemaining() <= 0) return "timeout" as const;
      } else await continueReading;
      check();
    }
    return r;
  }

  async function speakAll(list: PromptAudio[], deadline = false) {
    for (const p of list) {
      const r = await speak(p, { deadline });
      if (r === "timeout") return "timeout";
    }
    return "played";
  }

  // ---------- 录音 ----------
  async function ensureMic() {
    const rec = rt.current!.recorder;
    if (rec.trackLive) return;
    try {
      await rec.init(savedDeviceId());
      if(rt.current!.aborted){rec.release();throw new Aborted();}
      await rec.resumeContext();
    } catch (e) {
      if(e instanceof Aborted)throw e;
      const msg = e instanceof MicError ? e.message : MIC_ERROR_TEXT.unknown;
      throw new MicError((e as MicError).kind ?? "unknown", msg);
    }
  }

  type RecordOutcome = { res: StopResult | null; reason: "user" | "limit" | "deadline" | "interrupted" | "skip" };

  async function record(opts: {
    item: PlanItem;
    kind: AnswerKind;
    followUpId: string | null;
    promptText: string;
    limitMs: number | null;
    useDeadline: boolean;
    label: string;
    note?: string;
    allowSkip?: boolean;
  }): Promise<RecordOutcome> {
    check();
    await ensureMic();
    check();
    const rec = rt.current!.recorder;
    const submissionId = randomId("s");
    let interruptedFlag = false;
    const interrupted = new Promise<"interrupted">((resolve) => {
      rec.onInterrupted = () => {
        interruptedFlag = true;
        resolve("interrupted");
      };
    });
    const startLocal = await rec.start({
      userId,
      id: submissionId,
      sessionId,
      planIndex: opts.item.index,
      kind: opts.kind,
      followUpId: opts.followUpId,
      promptText: opts.promptText,
    });
    check();
    setExaminer("listening");
    setStep("recording");
    const deadlineMs = opts.useDeadline && rt.current!.partDeadline ? rt.current!.partDeadline : null;
    const totalMs = opts.limitMs ?? (deadlineMs ? deadlineMs - serverNow() : 0);
    setTimer({ startLocal, totalMs: Math.max(0, totalMs), label: opts.label, note: opts.note, tone: "listening" });

    const userP = waitFor([
      { id: "done", label: "我答完了", icon: "stop" },
      ...(opts.allowSkip ? [{ id: "skip", label: "跳过此题", variant: "ghost" as const }] : []),
    ]).then((id) => (id === "skip" ? ("skip" as const) : ("user" as const)));
    let limitTimer: ReturnType<typeof setInterval> | undefined;
    const limitP = new Promise<"limit" | "deadline">((resolve) => {
      const t = limitTimer = setInterval(() => {
        if (rt.current!.aborted) return clearInterval(t);
        if (opts.limitMs !== null && Date.now() - startLocal >= opts.limitMs) {
          clearInterval(t);
          resolve("limit");
        } else if (deadlineMs && serverNow() >= deadlineMs) {
          clearInterval(t);
          resolve("deadline");
        }
      }, 100);
    });
    const reason = await Promise.race([userP, limitP, interrupted]);
    clearInterval(limitTimer);
    cancelWait();
    const res = await rec.stop({ interrupted: reason === "interrupted" });
    rec.onInterrupted = null;
    setTimer(null);
    setExaminer("waiting");
    check();
    if (reason === "skip") {
      if (res) await deleteRecording(res.meta.id);
      return { res: null, reason: "skip" };
    }
    return { res, reason: interruptedFlag ? "interrupted" : reason };
  }

  function upload(res: StopResult) {
    const p = uploadQueue.enqueue(res.meta, res.blob);
    p.catch(() => {});
    return p;
  }

  async function sendEvent(type: string, extra: Record<string, unknown> = {}) {
    return api<{ partDeadlines?: Record<string, string>; finished?: boolean; missing?: unknown[]; status?: string }>(`/api/sessions/${sessionId}/events`, {
      body: { eventId: randomId("ev"), type, ...extra },
    });
  }

  // ---------- 开始面试（用户手势） ----------
  async function startInterview() {
    if (!view || phase !== "ready") return;
    const r = rt.current!;
    void r.audio.unlock(); // 必须在点击事件中同步调用（iOS 音频解锁）
    setPhase("starting");
    setError(null);
    try {
      await r.recorder.init(savedDeviceId());
      if(r.aborted){r.recorder.release();return;}
      await r.recorder.resumeContext();
    } catch (e) {
      if(r.aborted)return;
      setError(e instanceof MicError ? e.message : MIC_ERROR_TEXT.unknown);
      setPhase("ready");
      return;
    }
    setWakeLockOk(await r.wake.request());
    try {
      check();
      await sendEvent("start");
      check();
    } catch (e) {
      await r.wake.release();
      if(e instanceof Aborted||r.aborted)return;
      setError(e instanceof ApiError ? e.message : "网络错误");
      setPhase("ready");
      return;
    }
    setPhase("running");
    try {
      if (view.plan.mode === "mock") await runMock(view);
      else await runTraining(view);
    } catch (e) {
      if (e instanceof Aborted) return;
      if (e instanceof MicError) {
        setError(e.message);
        if (view.plan.mode === "mock") {
          await sendEvent("interrupt", { reason: "mic_error" }).catch(() => {});
          setPhase("interrupted");
          setMessage("麦克风不可用，本次模考已标记为“中断”。已录内容仍可复盘。");
        } else {
          setPhase("error");
        }
      } else {
        setError(e instanceof ApiError ? e.message : "发生错误，请刷新页面重试（已保存的回答不会丢失）");
        setPhase("error");
      }
    } finally {
      setExaminer("waiting");
      await r.wake.release();
    }
  }

  // ---------- 训练流程（闯关 / 自由练习 / 重练） ----------
  async function runTraining(v: SessionView) {
    const plan = v.plan;
    const saved = new Set(v.answers.filter((a) => a.status !== "created"&&!a.interrupted).map((a) => `${a.planIndex}:${a.kind}`));
    for (const m of localPending) if(!m.interrupted)saved.add(`${m.planIndex}:${m.kind}`);
    // 本地未上传的录音先补传
    for (const m of localPending) {
      const blob = await getBlob(m.id, m.mimeType);
      if (blob) void uploadQueue.enqueue(m, blob).catch(() => {});
    }
    const slotDone = (i: number, k: AnswerKind) => saved.has(`${i}:${k}`);
    const first = plan.items.findIndex((it) => !slotDone(it.index, "main") || (it.followUp && !slotDone(it.index, "followup")));

    if (first === 0 && !slotDone(0, "main")) await speak(plan.phrases.training_intro);

    for (let i = Math.max(0, first); first !== -1 && i < plan.items.length; i++) {
      const item = plan.items[i];
      setItemIndex(i);
      setKind("main");
      setFollowUpText(null);
      setAudioFailed(false);
      setNotes("");
      void sendEvent("position", { position: i }).catch(() => {});

      let skipped = false;
      if (!slotDone(i, "main")) {
        for (;;) {
          setPrompt(item.prompt.text);
          await speakAll(item.lead);
          await speak(item.prompt, { question: true });
          if (item.prepSeconds) {
            setStep("prep");
            setExaminer("waiting");
            const prepMs = item.prepSeconds * 1000;
            setTimer({ startLocal: Date.now(), totalMs: prepMs, label: "准备时间", note: "训练设置", tone: "prep" });
            const r = await Promise.race([
              waitFor([
                { id: "start", label: "开始回答" },
                { id: "skip", label: "跳过此题", variant: "ghost" },
              ]),
              sleep(prepMs).then(() => "timeout"),
            ]);
            cancelWait();
            setTimer(null);
            if (r === "skip") {
              skipped = true;
              break;
            }
            await speak(plan.phrases.prep_end);
          }
          const out = await record({
            item,
            kind: "main",
            followUpId: null,
            promptText: item.prompt.text,
            limitMs: (item.answerSeconds ?? 60) * 1000,
            useDeadline: false,
            label: item.part === 2 ? "陈述时间" : "作答时间",
            note: "训练设置：倒计时仅用于练习，不代表官方单题时限",
            allowSkip: true,
          });
          if (out.reason === "skip") {
            skipped = true;
            break;
          }
          if (!out.res) break;
          const up = upload(out.res);
          if (out.reason === "limit") await speak(plan.phrases.time_up);
          if (out.reason === "interrupted") {
            setStep("item_interrupted");
            setMessage("录音中断（麦克风断开或页面切到后台）。已录部分已保留，你可以重答本题。");
            const c = await waitFor([
              { id: "retry", label: "重答本题", icon: "retry" },
              { id: "keep", label: "保留已录部分并继续", variant: "outline" },
            ]);
            setMessage(null);
            if (c === "retry") continue;
          }
          saved.add(`${i}:main`);
          if (item.followUp) {
            await runFollowUp(item, up);
            break;
          }
          setStep("between");
          const c = await waitFor([
            { id: "next", label: i === plan.items.length - 1 ? "完成本关" : "下一题" },
            { id: "retry", label: "重答本题", variant: "outline", icon: "retry" },
          ]);
          if (c === "retry") continue;
          break;
        }
      } else if (item.followUp && !slotDone(i, "followup")) {
        await runFollowUp(item, Promise.resolve(null));
      }
      if (skipped) {
        await sendEvent("skip", { planIndex: i }).catch(() => {});
      }
    }
    await finishTraining(plan);
  }

  async function runFollowUp(item: PlanItem, mainUpload: Promise<unknown>) {
    const plan = view!.plan;
    for (;;) {
      setStep("followup_wait");
      setExaminer("processing");
      setMessage("考官正在根据你的回答准备追问…");
      await mainUpload.catch(() => null);
      check();
      let fu: { followUp: { id: string; text: string; ttsId: string | null }; answerSeconds: number };
      try {
        fu = await api(`/api/sessions/${sessionId}/followup`, { body: { planIndex: item.index } });
      } catch {
        const c = item.followUp!.candidates.find((x) => x.id === item.followUp!.defaultId)!;
        fu = { followUp: { id: c.id, text: c.text, ttsId: c.ttsId }, answerSeconds: item.followUp!.answerSeconds };
      }
      check();
      setMessage(null);
      setKind("followup");
      setFollowUpText(fu.followUp.text);
      setPrompt(fu.followUp.text);
      setAudioFailed(false);
      await speak(plan.phrases.followup_lead);
      await speak({ text: fu.followUp.text, ttsId: fu.followUp.ttsId }, { question: true });
      const out = await record({
        item,
        kind: "followup",
        followUpId: fu.followUp.id,
        promptText: fu.followUp.text,
        limitMs: fu.answerSeconds * 1000,
        useDeadline: false,
        label: "追问作答时间",
        note: "训练设置",
      });
      if (out.res) upload(out.res);
      if (out.reason === "limit") await speak(plan.phrases.time_up);
      setStep("between");
      const c = await waitFor([
        { id: "next", label: item.index === plan.items.length - 1 ? "完成本关" : "下一题" },
        { id: "retry", label: "重答追问", variant: "outline", icon: "retry" },
      ]);
      if (c !== "retry") return;
      mainUpload = Promise.resolve(null);
    }
  }

  async function drainUploads(): Promise<boolean> {
    setStep("saving");
    setExaminer("processing");
    setMessage("正在保存录音…");
    await uploadQueue.drain();
    check();
    setMessage(null);
    return uploadQueue.failedEntries.length === 0;
  }

  async function finishTraining(plan: SessionPlan) {
    check();
    setPhase("finishing");
    setItemIndex(null);
    setPrompt(null);
    for (;;) {
      const ok = await drainUploads();
      if (ok) break;
      setStep("between");
      setMessage("有录音上传失败，已保留在本机。请检查网络后重试。");
      const c = await waitFor([
        { id: "retry_upload", label: "重试上传", icon: "retry" },
        { id: "skip_upload", label: "稍后再说", variant: "outline" },
      ]);
      if (c === "skip_upload") break;
      for (const [id] of uploadQueue.failedEntries) {
        const all = await listRecordings(sessionId);
        const m = all.find((x) => x.id === id);
        if (m) void uploadQueue.enqueue(m).catch(() => {});
      }
    }
    const r = await sendEvent("finish");
    check();
    setExaminer("waiting");
    if (r.finished) {
      await speak(plan.phrases.training_end).catch(() => {});
      check();
      setPhase("done");
    } else {
      setPhase("incomplete");
      setMessage(`还有 ${r.missing?.length ?? 0} 个题目未完成（已完成的回答已保存）。可以继续作答，或稍后回来继续同一会话。`);
    }
  }

  // ---------- 完整模考 ----------
  async function startPart(part: 1 | 2 | 3, plan: SessionPlan) {
    // 浏览器时钟校正仍有 RTT 误差；以服务端截止时刻为准重试，不延长考试。
    let r: Awaited<ReturnType<typeof sendEvent>> | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      try { r = await sendEvent("part_start", { part }); break; }
      catch (error) {
        if (!(error instanceof ApiError) || error.code !== "part_order" || attempt === 4) throw error;
        await sleep(250);
      }
    }
    if (!r) throw new Error("无法开始下一部分");
    check();
    const deadline = Date.parse(r.partDeadlines![String(part)]);
    rt.current!.partDeadline = deadline;
    setPartInfo({ part, deadline, totalMs: plan.mock!.parts[String(part) as "1"].durationSec * 1000 });
  }

  async function runQAPart(part: 1 | 3, plan: SessionPlan) {
    const idxs = plan.mock!.parts[String(part) as "1" | "3"].items;
    const asked = new Set<number>();
    for (;;) {
      const st = nextMockStep(part, idxs, asked, partRemaining(), plan.timeScale);
      if (st.type === "end_part") { await waitPartEnd(); return; }
      const item = plan.items[st.itemIndex];
      asked.add(st.itemIndex);
      setItemIndex(item.index);
      setKind(item.kind);
      setPrompt(item.prompt.text);
      setAudioFailed(false);
      if ((await speakAll(item.lead, true)) === "timeout") return "timeout";
      if ((await speak(item.prompt, { question: true, deadline: true })) === "timeout") return "timeout";
      const out = await record({
        item,
        kind: item.kind,
        followUpId: item.followUpId ?? null,
        promptText: item.prompt.text,
        limitMs: null,
        useDeadline: true,
        label: `Part ${part} 剩余时间`,
      });
      if (out.res) upload(out.res);
      if (out.reason === "interrupted") throw new MockInterrupted();
      if (out.reason === "deadline") {
        return "timeout";
      }
    }
  }

  async function waitPartEnd() {
    setTimer(null);
    setStep("between");
    setMessage("本部分作答已结束，剩余时间结束后自动进入下一部分。");
    while (partRemaining() > 0) { await sleep(Math.min(200, partRemaining())); check(); }
    setMessage(null);
  }

  async function runMock(v: SessionView) {
    const plan = v.plan;
    try {
      // Part 1
      await startPart(1, plan);
      await speak(plan.phrases.mock_intro, { deadline: true });
      await runQAPart(1, plan);

      // Part 2：引导语 → 60 秒准备 → 最长 120 秒陈述 → "Thank you." → 剩余 ≥ 25 秒时追加收尾问题
      await startPart(2, plan);
      await speak(plan.phrases.p1_to_p2, { deadline: true });
      const p2Idx = plan.mock!.parts["2"].items;
      const card = plan.items[p2Idx[0]];
      setItemIndex(card.index);
      setKind("main");
      setPrompt(card.prompt.text);
      await speakAll(card.lead, true);
      await speak(card.prompt, { question: true, deadline: true });
      setStep("prep");
      const prepMs = p2PrepLimitMs(partRemaining(), plan.timeScale);
      setTimer({ startLocal: Date.now(), totalMs: prepMs, label: "准备时间（1 分钟）", tone: "prep" });
      await Promise.race([waitFor([{ id: "start", label: "准备好了，开始陈述" }]), sleep(prepMs)]);
      cancelWait();
      setTimer(null);
      await speak(plan.phrases.p2_start, { deadline: true });
      const speakLimit = p2SpeakLimitMs(partRemaining(), plan.timeScale);
      const out = await record({
        item: card,
        kind: "main",
        followUpId: null,
        promptText: card.prompt.text,
        limitMs: speakLimit,
        useDeadline: true,
        label: "陈述时间（最长 2 分钟）",
      });
      if (out.res) upload(out.res);
      if (out.reason === "interrupted") throw new MockInterrupted();
      let cut = out.reason === "deadline";
      if (out.reason === "limit") await speak(plan.phrases.p2_stop);
      const roundingIdx = p2Idx[1];
      if (!cut && roundingIdx !== undefined && canAskRounding(partRemaining(), plan.timeScale)) {
        const rItem = plan.items[roundingIdx];
        setItemIndex(rItem.index);
        setKind("rounding");
        setPrompt(rItem.prompt.text);
        setAudioFailed(false);
        await speak(rItem.prompt, { question: true, deadline: true });
        const r2 = await record({
          item: rItem,
          kind: "rounding",
          followUpId: rItem.followUpId ?? null,
          promptText: rItem.prompt.text,
          limitMs: null,
          useDeadline: true,
          label: "Part 2 剩余时间",
        });
        if (r2.res) upload(r2.res);
        if (r2.reason === "interrupted") throw new MockInterrupted();
        cut = r2.reason === "deadline";
      }
      await waitPartEnd();

      // Part 3
      await startPart(3, plan);
      await speak(plan.phrases.p2_to_p3, { deadline: true });
      await runQAPart(3, plan);
      rt.current!.partDeadline = null;
      setPartInfo(null);
      setItemIndex(null);
      setPrompt(null);
      await speak(plan.phrases.closing);

      setPhase("finishing");
      for (;;) {
        const ok = await drainUploads();
        if (ok) break;
        setStep("between");
        setMessage("有录音上传失败，已保留在本机。请检查网络后重试。");
        const c = await waitFor([
          { id: "retry_upload", label: "重试上传", icon: "retry" },
          { id: "skip_upload", label: "稍后再说", variant: "outline" },
        ]);
        if (c === "skip_upload") break;
        const all = await listRecordings(sessionId);
        for (const m of all) void uploadQueue.enqueue(m).catch(() => {});
      }
      const r = await sendEvent("finish");
      check();
      setPhase(r.status === "completed" ? "done" : "interrupted");
    } catch (e) {
      if (e instanceof MockInterrupted) {
        await uploadQueue.drain();
        check();
        await sendEvent("interrupt", { reason: "recording_interrupted" }).catch(() => {});
        setPhase("interrupted");
        setMessage("录音中断（麦克风断开、来电或锁屏）。本次模考已标记为“中断”，已录内容仍可复盘。");
        return;
      }
      throw e;
    }
  }

  const returnToDiscs=rhine?.library?rhine.practiceHref:`/practice?disc=${encodeURIComponent(view?.plan.items[0]?.questionId??"")}`;
  async function exitInterview() {
    if(exitBusy.current)return;
    exitBusy.current=true;
    const r=rt.current!;
    exitMock.current ||= view?.plan.mode==="mock"&&["starting","running","finishing"].includes(phase);
    const interruptMock=exitMock.current;
    r.aborted=true;r.audio.stop();stopDiscPlayback?.();
    r.waiter?.resolve("exit");r.waiter=null;
    setPhase("exiting");setStep("idle");setTimer(null);setPartInfo(null);setActions([]);setExaminer("waiting");setError(null);
    try{
      const res=await r.recorder.stop({interrupted:true});
      r.recorder.release();await r.wake.release();
      const jobs:Promise<unknown>[]=[];
      if(res)jobs.push(upload(res));
      // Include earlier pending fragments and retry a failed exit without losing them.
      for(const meta of await listRecordings(sessionId)){
        if(meta.id===res?.meta.id)continue;
        const job=uploadQueue.enqueue(meta);job.catch(()=>{});jobs.push(job);
      }
      // Mock uploads must obtain their tickets before the session is closed.
      if(interruptMock||!persistent){const results=await Promise.allSettled(jobs);if(results.some(r=>r.status==="rejected"))throw new Error("有录音尚未上传，请联网后重试退出；已录内容仍保留在本机。");}
      if(interruptMock)await sendEvent("interrupt",{reason:"user_exit"});
      router.push(returnToDiscs);
    }catch(e){
      r.recorder.release();await r.wake.release();
      setError(e instanceof Error?e.message:"保存失败，请重试退出。已录内容保留在本机。");
      exitBusy.current=false;
    }
  }

  // ---------- 渲染 ----------
  if (phase === "loading" || !view) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
        <Button variant="outline" onClick={exitInterview} data-testid="exit-interview"><LogOut size={15}/>退出面试</Button>
        {error ? <Alert tone="danger">{error}</Alert> : <Spinner label="正在准备面试室…" />}
        {preload ? <div className="space-y-3"><Progress value={(preload.done / Math.max(1, preload.total)) * 100} className="max-w-xs" /><p role="status" className="text-sm text-muted">考官语音已准备 {preload.done} / {preload.total} 条。准备完成前不会开始计时。</p><p className="text-xs text-muted">首次生成自然语音可能较慢，请保持连接。网络请求超时后可重新加载。</p><Button variant="outline" onClick={() => location.reload()}>重新加载语音</Button><LinkButton href="/" variant="ghost">返回首页</LinkButton></div> : null}
      </div>
    );
  }

  const plan = view.plan;
  const isMock = plan.mode === "mock";
  const item = itemIndex !== null ? plan.items[itemIndex] : null;
  const subtitleForced = PREFS_SUBTITLE[subtitlePref];
  const showText = audioFailed || (subtitleForced ?? plan.hints.showText);
  const showCard = !!item?.card && (plan.hints.showCard || isMock) && kind === "main";
  const hintShow = {
    zh: !isMock && plan.hints.showZh && kind === "main",
    keywords: !isMock && plan.hints.showKeywords && kind === "main",
    expressions: !isMock && plan.hints.showExpressions && kind === "main",
    structure: !isMock && plan.hints.showStructure && kind === "main",
  };
  const remainingTimer = timer ? Math.max(0, timer.totalMs - (now - timer.startLocal)) : 0;
  const partRemainMs = partInfo ? Math.max(0, partInfo.deadline - serverNow()) : 0;
  void uploadVersion;
  const uploadsPending = uploadQueue.pendingCount;
  const uploadsFailed = uploadQueue.failedEntries.length;
  const total = plan.items.length;

  return (
    <div className="terminal-main recording-room" data-testid="interview-room" data-phase={phase} data-step={step}>
      <div className="interview-toolbar mb-3 flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">{plan.title}</h1>
        <Badge tone="brand">{plan.subtitle}</Badge>
        {plan.draft ? <DraftBadge /> : null}
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={exitInterview} disabled={phase==="exiting"&&!error} data-testid="exit-interview"><LogOut size={15}/>{phase==="exiting"&&!error?"正在保存并退出…":error&&phase==="exiting"?"重试退出":"退出面试"}</Button>
          {uploadsPending > 0 ? (
            <Badge tone="muted">
              <CloudUpload className="h-3.5 w-3.5" /> 上传中 {uploadsPending}
            </Badge>
          ) : null}
          {uploadsFailed > 0 ? <Badge tone="danger">上传失败 {uploadsFailed}</Badge> : null}
        </div>
      </div>

      {!online && <Alert tone="warning" className="mb-3">网络已断开。当前录音会先保留在本机；请保持页面打开，恢复网络后重试上传。模考计时继续。</Alert>}
      {!persistent ? (
        <Alert tone="warning" className="mb-3">
          浏览器本地存储不可用或空间不足，录音暂存在内存中；请保持页面打开，确认上传成功后再离开。
        </Alert>
      ) : null}
      {wakeLockOk === false && phase === "running" ? (
        <Alert tone="info" className="mb-3">
          当前浏览器不支持保持屏幕常亮，请暂时关闭手机自动锁屏，避免录音被打断。
        </Alert>
      ) : null}

      <div className="recording-layout">
        {/* 考官区 */}
        <section className="recording-stage">
          <DiscScene variant="studio" ids={[item?.questionId ?? plan.items[0]?.questionId ?? "SPEAK"]} paused={rt.current!.aborted} state={rt.current!.aborted?"idle":step === "recording" && rt.current!.recorder.recording ? "recording" : phase === "ready" ? "idle" : phase === "starting" ? "loading" : phase === "done" ? "saved" : step === "speaking" ? "speaking" : step === "saving" || phase === "finishing" ? "saving" : "saved"} />
          <ol className="disc-workflow" aria-label="录制流程"><li data-active={step === "speaking"}>01 / 播放提问</li><li data-active={step === "recording"}>02 / 录制回答</li><li data-active={step === "saving" || phase === "finishing" || phase === "done"}>03 / 保存分析</li></ol>
          {partInfo ? (
            <div className="w-full">
              <CountdownDisplay remainingMs={partRemainMs} totalMs={partInfo.totalMs} label={`Part ${partInfo.part} 剩余时间`} />
            </div>
          ) : null}
          {phase === "running" && item && !isMock ? (
            <p className="text-sm text-muted">
              第 {item.index + 1} / {total} 题{kind === "followup" ? " · 追问" : ""}
            </p>
          ) : null}
          {phase === "running" && isMock && partInfo ? <p className="text-sm text-muted">Part {partInfo.part}</p> : null}
        </section>

        {/* 题目与作答区 */}
        <section className="recording-content">
          {phase==="exiting"&&<Alert tone={error?"warning":"info"}>{error??"声音与动画已暂停，正在保留已录内容并返回当前磁盘。"}</Alert>}
          <div className="recording-communication"><p className="terminal-kicker">{step === "recording" ? "RECORDING / 正在记录" : step === "speaking" ? "PLAYING / 播放提问" : phase === "done" ? "SAVED / 已保存" : "TRAINING / 训练终端"}</p><ExaminerAvatar state={examiner}/></div>
          {phase === "ready" || phase === "starting" ? (
            <ReadyPanel
              plan={plan}
              preload={preload}
              localPending={localPending}
              error={error}
              starting={phase === "starting"}
              onStart={startInterview}
              onDiscardLocal={async (id) => {
                await deleteRecording(id);
                setLocalPending(await listRecordings(sessionId));
              }}
            />
          ) : null}

          {phase === "running" || phase === "finishing" ? (
            <>
              {item && (showText || showCard) ? (
                <div className="space-y-3">
                  {showCard ? <TaskCard item={item} /> : null}
                  {showText && !showCard && prompt ? (
                    <p className="text-lg font-medium leading-snug" data-testid="prompt-text">
                      {prompt}
                    </p>
                  ) : null}
                  {kind === "followup" && followUpText && !showText ? <p className="text-sm text-muted">考官追问（字幕已隐藏）</p> : null}
                </div>
              ) : item ? (
                <p className="text-sm text-muted" data-testid="prompt-hidden">
                  {isMock ? "模考中问答字幕默认隐藏，请专注听考官提问。" : "字幕已按你的设置隐藏。"}
                </p>
              ) : null}

              {item && step !== "recording" && kind === "main" ? <HintPanel item={item} show={hintShow} /> : null}
              {item && showCard && (step === "prep" || step === "recording") && plan.hints.notes ? (
                <NotesPad value={notes} onChange={setNotes} />
              ) : null}

              {timer ? <CountdownDisplay remainingMs={remainingTimer} totalMs={timer.totalMs} label={timer.label} note={timer.note} tone={timer.tone} /> : null}

              {step === "recording" ? (
                <div className="space-y-2" data-testid="recording-indicator">
                  <div className="flex items-center gap-2 text-sm font-medium text-emerald-700">
                    <span className="relative flex h-3 w-3">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                      <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
                    </span>
                    正在录音 · 已录 {timer ? Math.floor((now - timer.startLocal) / 1000) : 0} 秒（短暂停顿不会结束录音）
                  </div>
                  <Waveform recorder={rt.current!.recorder} active className="h-16 w-full rounded-lg bg-emerald-50/50" />
                </div>
              ) : null}

              {message ? <Alert tone={step === "item_interrupted" ? "warning" : "info"}>{message}</Alert> : null}
              {step === "saving" || step === "followup_wait" ? <Spinner label={message ?? "处理中…"} /> : null}
              {error ? <Alert tone="danger">{error}</Alert> : null}

              <div className="mt-auto flex flex-wrap gap-2 pt-2" data-testid="actions">
                {actions.map((a, i) => (
                  <Button
                    key={a.id}
                    data-action={a.id}
                    variant={a.variant ?? (i === 0 ? "primary" : "outline")}
                    size={i === 0 ? "lg" : "md"}
                    className={cn(i === 0 && "min-w-40 flex-1 sm:flex-none")}
                    onClick={() => trigger(a.id)}
                  >
                    {a.icon === "stop" ? <Square className="h-4 w-4 fill-current" /> : a.icon === "retry" ? <RotateCcw className="h-4 w-4" /> : null}
                    {a.label}
                  </Button>
                ))}
              </div>
              {actions.length ? <p className="text-xs text-muted">键盘：Enter 或空格 = 主要操作</p> : null}
            </>
          ) : null}

          {phase === "done" ? (
            <EndPanel
              tone="success"
              title={isMock ? "模考完成！" : "本次练习完成！"}
              text="录音已保存，反馈正在后台生成。可以先离开，稍后在学习记录中查看。"
              sessionId={sessionId}
            />
          ) : null}
          {phase === "incomplete" ? (
            <div className="space-y-3">
              <Alert tone="warning" title="还有未完成的题目">
                {message}
              </Alert>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => window.location.reload()}>继续作答</Button>
                <LinkButton href={`/sessions/${sessionId}`} variant="outline">
                  查看已完成部分的报告
                </LinkButton>
              </div>
            </div>
          ) : null}
          {phase === "interrupted" ? (
            <EndPanel tone="warning" title="本次模考已中断" text={message ?? "已录内容仍可复盘。"} sessionId={sessionId} />
          ) : null}
          {phase === "closed" ? (
            <EndPanel tone="info" title="这次练习已经结束" text="可以在报告中回听录音、查看反馈，或重新开始。" sessionId={sessionId} />
          ) : null}
          {phase === "error" ? (
            <div className="space-y-3">
              <Alert tone="danger" title="出现问题">
                {error}
              </Alert>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => window.location.reload()}>刷新重试</Button>
                <LinkButton href="/device-check" variant="outline">
                  检查麦克风
                </LinkButton>
                <LinkButton href={`/sessions/${sessionId}`} variant="ghost">
                  查看已保存的回答
                </LinkButton>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

class MockInterrupted extends Error {}

function collectTtsIds(plan: SessionPlan): string[] {
  const ids = new Set<string>();
  const add = (p?: PromptAudio | null) => p?.ttsId && ids.add(p.ttsId);
  Object.values(plan.phrases).forEach(add);
  for (const i of plan.items) {
    add(i.prompt);
    i.lead.forEach(add);
    i.followUp?.candidates.forEach(add);
  }
  return [...ids];
}

function ReadyPanel({
  plan,
  preload,
  localPending,
  error,
  starting,
  onStart,
  onDiscardLocal,
}: {
  plan: SessionPlan;
  preload: { done: number; total: number; failed: number } | null;
  localPending: RecordingMeta[];
  error: string | null;
  starting: boolean;
  onStart: () => void;
  onDiscardLocal: (id: string) => void;
}) {
  const isMock = plan.mode === "mock";
  return (
    <div className="flex flex-1 flex-col gap-4" data-testid="ready-panel">
      <div className="space-y-2">
        <p className="font-medium">{isMock ? "完整模考：Part 1（4:30）→ Part 2（3:30）→ Part 3（4:30）" : `本次共 ${plan.items.length} 题`}</p>
        {plan.goal?.description ? <p className="text-sm text-muted">目标：{plan.goal.description}</p> : null}
        <p className="text-sm text-muted">{plan.hintNote}</p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          <li>考官说完后才开始录音；建议佩戴耳机、在安静环境作答。</li>
          <li>点击“我答完了”可提前提交；{isMock ? "各部分时间到时自动提交并进入下一部分。" : "倒计时结束会自动停止并提交。"}</li>
          {isMock ? <li>模考不能暂停或重答；开始后退出、刷新或关闭页面会标记为“中断”，已录内容仍可复盘。</li> : <li>题与题之间可以暂停；退出会保留已录内容，回来后可继续练习。</li>}
        </ul>
      </div>
      {preload && preload.failed > 0 ? (
        <Alert tone="warning"><p>有 {preload.failed} 条考官音频暂时不可用，播放失败时会显示题目文字。</p><Button variant="outline" size="sm" className="mt-2" onClick={() => location.reload()}>重试准备语音</Button></Alert>
      ) : null}
      {localPending.length > 0 ? (
        <Alert tone="warning" title={`本机有 ${localPending.length} 段未上传的录音`}>
          <p>开始后会自动重试上传。也可以删除它们：</p>
          <ul className="mt-1 space-y-1">
            {localPending.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2">
                <span className="truncate">
                  第 {m.planIndex + 1} 题 · {Math.round(m.durationMs / 1000)} 秒
                </span>
                <Button size="sm" variant="ghost" onClick={() => onDiscardLocal(m.id)}>
                  删除
                </Button>
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="danger" title="无法开始" action={<LinkButton href="/device-check" size="sm" variant="outline">去设备检查</LinkButton>}>
          {error}
        </Alert>
      ) : null}
      <div className="mt-auto">
        <Button size="lg" className="w-full sm:w-auto" onClick={onStart} disabled={starting} data-testid="start-interview">
          <Mic className="h-5 w-5" />
          {starting ? "正在连接麦克风…" : "开始面试"}
        </Button>
      </div>
    </div>
  );
}

function EndPanel({ tone, title, text, sessionId }: { tone: "success" | "warning" | "info"; title: string; text: string; sessionId: string }) {
  return (
    <div className="flex flex-1 flex-col items-start gap-4" data-testid="end-panel">
      <div className="flex items-center gap-2 text-lg font-semibold">
        {tone === "success" ? <CheckCircle2 className="h-6 w-6 text-emerald-600" /> : <AlertTriangle className="h-6 w-6 text-amber-600" />}
        {title}
      </div>
      <p className="text-sm text-muted">{text}</p>
      <div className="flex flex-wrap gap-2">
        <LinkButton href={`/sessions/${sessionId}`} size="lg" data-testid="view-report">
          查看本次报告
        </LinkButton>
        <Link href="/" className="self-center text-sm text-muted underline">
          返回首页
        </Link>
      </div>
    </div>
  );
}
