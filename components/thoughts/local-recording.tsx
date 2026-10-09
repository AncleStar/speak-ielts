"use client";
import { useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { mapMicError, pickMimeType } from "@/lib/client/recorder";
import { PRIVATE_SESSION_EVENT, RECORDING_CONSENT_EVENT } from "@/lib/client/private-session";
import { localIdentity, recordingPermitted } from "@/lib/client/idb";

/** Thought rehearsal stays in this component's memory, outside the interview upload queue. */
export function LocalRecording({ onRecorded, onBusy, disabled = false }: { onRecorded: (seconds: number) => void; onBusy: (busy: boolean) => void; disabled?: boolean }) {
  const [active, setActive] = useState(false), [opening, setOpening] = useState(false), [seconds, setSeconds] = useState(0);
  const [audio, setAudio] = useState(""), [error, setError] = useState("");
  const [allowed, setAllowed] = useState(recordingPermitted);
  const attempt = useRef(0), consentBlocked = useRef(!recordingPermitted());
  const stream = useRef<MediaStream | null>(null), recorder = useRef<MediaRecorder | null>(null);
  const mounted = useRef(true), url = useRef(""), startAt = useRef(0), interrupted = useRef(false);
  const busyCallback = useRef(onBusy), recordedCallback = useRef(onRecorded);
  busyCallback.current = onBusy; recordedCallback.current = onRecorded;
  useEffect(() => {
    mounted.current = true;
    const stopInBackground = () => { if (document.hidden && recorder.current?.state === "recording") { interrupted.current = true; recorder.current.stop(); } };
    const warn = (event: BeforeUnloadEvent) => { if (recorder.current?.state === "recording") { event.preventDefault(); event.returnValue = ""; } };
    const sessionEnded = () => { mounted.current = false; interrupted.current = true; if (recorder.current?.state === "recording") recorder.current.stop(); stream.current?.getTracks().forEach(t => t.stop()); if (url.current) URL.revokeObjectURL(url.current); url.current = ""; delete document.documentElement.dataset.recording; };
    window.addEventListener(PRIVATE_SESSION_EVENT, sessionEnded);
    const consentChanged = (event: Event) => { attempt.current++; consentBlocked.current = !(event as CustomEvent<{ allowed: boolean }>).detail?.allowed; setAllowed(!consentBlocked.current); interrupted.current = true; if (recorder.current) { recorder.current.ondataavailable = null; recorder.current.onstop = null; if (recorder.current.state !== "inactive") recorder.current.stop(); } stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; if (url.current) URL.revokeObjectURL(url.current); url.current = ""; setAudio(""); setActive(false); setOpening(false); setSeconds(0); busyCallback.current(false); recordedCallback.current(0); delete document.documentElement.dataset.recording; setError("录音授权已改变，本次页面录音已释放。文字练习可继续；请重新同意后录音。"); };
    window.addEventListener(RECORDING_CONSENT_EVENT, consentChanged);
    document.addEventListener("visibilitychange", stopInBackground); window.addEventListener("beforeunload", warn);
    return () => { mounted.current = false; document.removeEventListener("visibilitychange", stopInBackground); window.removeEventListener("beforeunload", warn);
      window.removeEventListener(PRIVATE_SESSION_EVENT, sessionEnded);
      window.removeEventListener(RECORDING_CONSENT_EVENT, consentChanged);
      if (recorder.current?.state === "recording") recorder.current.stop(); stream.current?.getTracks().forEach(t => t.stop());
      if (url.current) URL.revokeObjectURL(url.current); delete document.documentElement.dataset.recording; busyCallback.current(false); };
  }, []);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setSeconds(Math.min(180, Math.floor((Date.now() - startAt.current) / 1000)));
      if (Date.now() - startAt.current >= 180_000 && recorder.current?.state === "recording") recorder.current.stop();
    }, 200);
    return () => clearInterval(timer);
  }, [active]);
  async function start() {
    if (disabled || consentBlocked.current || !recordingPermitted()) return;
    const thisAttempt = ++attempt.current, consentVersion = localIdentity()?.consentVersion;
    setError(""); setOpening(true); busyCallback.current(true);
    try {
      if (!window.isSecureContext) throw new Error("录音需要 HTTPS 或 localhost 连接。");
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("当前浏览器不支持录音，请使用 Chrome、Edge 或 Safari。");
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      if (!mounted.current || attempt.current !== thisAttempt || consentBlocked.current || !recordingPermitted() || localIdentity()?.consentVersion !== consentVersion) { mic.getTracks().forEach(t => t.stop()); return; }
      stream.current = mic;
      const mime = pickMimeType(); const mr = mime ? new MediaRecorder(mic, { mimeType: mime }) : new MediaRecorder(mic);
      recorder.current = mr; const chunks: Blob[] = []; interrupted.current = false;
      mr.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      mr.onerror = () => { interrupted.current = true; if (mr.state !== "inactive") mr.stop(); };
      mic.getAudioTracks()[0].addEventListener("ended", () => { if (mr.state !== "inactive") { interrupted.current = true; mr.stop(); } });
      mr.onstop = () => {
        mic.getTracks().forEach(t => t.stop()); stream.current = null; delete document.documentElement.dataset.recording;
        if (!mounted.current || attempt.current !== thisAttempt || !recordingPermitted() || localIdentity()?.consentVersion !== consentVersion) return;
        const duration = Math.min(180, (Date.now() - startAt.current) / 1000);
        setActive(false); setSeconds(Math.floor(duration)); busyCallback.current(false);
        if (interrupted.current || !chunks.length) { setError("录音已中断，请保持页面在前台后重新录音。"); recordedCallback.current(0); return; }
        if (url.current) URL.revokeObjectURL(url.current);
        url.current = URL.createObjectURL(new Blob(chunks, { type: mr.mimeType || mime || "audio/webm" })); setAudio(url.current); recordedCallback.current(duration);
      };
      if (url.current) URL.revokeObjectURL(url.current); url.current = ""; setAudio(""); recordedCallback.current(0);
      startAt.current = Date.now(); setSeconds(0); mr.start(250); setActive(true); document.documentElement.dataset.recording = "true";
    } catch (e) {
      stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; busyCallback.current(false);
      if (mounted.current && attempt.current === thisAttempt) setError(e instanceof Error && e.name === "Error" ? e.message : mapMicError(e).message);
    } finally { if (mounted.current && attempt.current === thisAttempt) setOpening(false); }
  }
  return <div className="thought-recorder">
    <div className="thought-actions"><Button onClick={() => active ? recorder.current?.stop() : void start()} disabled={opening || disabled || !allowed} variant={active ? "danger" : "secondary"}>
      {active ? <Square size={15} /> : <Mic size={15} />}{opening ? "正在打开麦克风…" : active ? "结束录音" : audio ? "重新录音" : "开始录音"}</Button>
      <span className={active ? "thought-recording-time is-recording" : "thought-recording-time"} role="timer">{String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")} / 03:00</span>
    </div>
    {audio && <audio src={audio} controls preload="metadata" aria-label="本次观点练习录音" />}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {!allowed && <p className="thought-note">录音授权尚未同意或已撤回。可继续填写文字，或前往设置重新同意。</p>}
    <p className="thought-note">录音仅在当前页面回放，离开后释放。保存练习会记录时长、自评和你填写的尝试表达。</p>
  </div>;
}
