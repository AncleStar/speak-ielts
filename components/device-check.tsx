"use client";

import { CheckCircle2, Headphones, Mic, Play, RefreshCw, Square } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/feedback";
import { Field, Select } from "@/components/ui/form";
import { ExaminerAudio } from "@/lib/client/examiner-audio";
import { DEVICE_KEY, MicError, MicRecorder, MIC_ERROR_TEXT, pickMimeType, savedDeviceId, type MicErrorKind } from "@/lib/client/recorder";
import { LevelMeter } from "./interview/waveform";

const TEST_SECONDS = 5;

function PermissionHelp() {
  return (
    <div className="space-y-2 text-sm">
      <p className="font-medium">如何开启麦克风权限：</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <b>电脑 Chrome / Edge：</b>点击地址栏左侧的“网站信息”图标 → 网站设置 → 麦克风 → 允许，然后点“重新检测”。Windows 还需在“设置 → 隐私和安全性 → 麦克风”中允许浏览器使用麦克风。
        </li>
        <li>
          <b>Android Chrome：</b>地址栏右侧“⋮” → 设置 → 网站设置 → 麦克风，允许本站；并确认手机“设置 → 应用 → Chrome → 权限”中麦克风已开启。
        </li>
        <li>
          <b>iPhone Safari：</b>点地址栏左侧“大小”图标 → 网站设置 → 麦克风 → 允许；或在“设置 → Safari 浏览器 → 麦克风”中选择“询问”或“允许”。
        </li>
      </ul>
    </div>
  );
}

export function DeviceCheck({ sampleTtsId, next, voiceLabel }: { sampleTtsId: string | null; next: string | null; voiceLabel: string }) {
  const router = useRouter();
  const rec = useRef<MicRecorder | null>(null);
  const audio = useRef<ExaminerAudio | null>(null);
  const [status, setStatus] = useState<"idle" | "requesting" | "ready" | "error">("idle");
  const [errKind, setErrKind] = useState<MicErrorKind | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");
  const [level, setLevel] = useState(0);
  const [testing, setTesting] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [testUrl, setTestUrl] = useState<string | null>(null);
  const [peak, setPeak] = useState(0);
  const [voice, setVoice] = useState<"idle" | "playing" | "ok" | "failed">("idle");
  const [trackLost, setTrackLost] = useState(false);

  useEffect(() => {
    rec.current = new MicRecorder();
    audio.current = new ExaminerAudio();
    setDeviceId(savedDeviceId() ?? "");
    return () => {
      rec.current?.release();
      audio.current?.dispose();
    };
  }, []);

  useEffect(() => {
    if (status !== "ready") return;
    let raf = 0;
    const tick = () => {
      setLevel(rec.current?.level() ?? 0);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [status]);

  async function connect(id?: string) {
    setStatus("requesting");
    setErrKind(null);
    setTrackLost(false);
    try {
      await rec.current!.init(id || undefined);
      await rec.current!.resumeContext();
      rec.current!.onInterrupted = () => setTrackLost(true);
      const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
      setDevices(list);
      const actual = rec.current!.stream?.getAudioTracks()[0]?.getSettings().deviceId;
      if (actual) setDeviceId(actual);
      setStatus("ready");
    } catch (e) {
      setErrKind(e instanceof MicError ? e.kind : "unknown");
      setStatus("error");
    }
  }

  async function onSelectDevice(id: string) {
    setDeviceId(id);
    try {
      localStorage.setItem(DEVICE_KEY, id);
    } catch {
      /* ignore */
    }
    await connect(id);
  }

  async function testRecord() {
    const stream = rec.current?.stream;
    if (!stream) return;
    setTesting(true);
    setTestUrl(null);
    setPeak(0);
    const mime = pickMimeType();
    const mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    const chunks: Blob[] = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    let maxLevel = 0;
    const meter = setInterval(() => {
      maxLevel = Math.max(maxLevel, rec.current?.level() ?? 0);
    }, 100);
    mr.onstop = () => {
      clearInterval(meter);
      setPeak(maxLevel);
      setTestUrl(URL.createObjectURL(new Blob(chunks, { type: mr.mimeType || mime })));
      setTesting(false);
    };
    mr.start(500);
    for (let s = TEST_SECONDS; s > 0; s--) {
      setCountdown(s);
      await new Promise((r) => setTimeout(r, 1000));
    }
    setCountdown(0);
    mr.stop();
  }

  async function testVoice() {
    setVoice("playing");
    await audio.current!.unlock();
    const r = await audio.current!.play(sampleTtsId);
    setVoice(r === "played" ? "ok" : "failed");
  }

  const ready = status === "ready";

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mic className="h-5 w-5 text-brand-600" /> 1. 麦克风
          </CardTitle>
          <CardDescription>浏览器会询问是否允许使用麦克风，请选择“允许”。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {status === "idle" || status === "requesting" ? (
            <Button onClick={() => connect(deviceId)} disabled={status === "requesting"} data-testid="mic-connect">
              {status === "requesting" ? "正在请求权限…" : "检测麦克风"}
            </Button>
          ) : null}
          {status === "error" && errKind ? (
            <div className="space-y-3">
              <Alert tone="danger" title="麦克风不可用">
                {MIC_ERROR_TEXT[errKind]}
              </Alert>
              {errKind === "permission" ? <PermissionHelp /> : null}
              <Button variant="outline" onClick={() => connect(deviceId)}>
                <RefreshCw className="h-4 w-4" /> 重新检测
              </Button>
            </div>
          ) : null}
          {ready ? (
            <>
              <Alert tone="success">麦克风已连接。对着麦克风说话，音量条应随声音跳动。</Alert>
              {trackLost ? <Alert tone="warning">麦克风已断开（设备被拔出或权限被收回），请重新检测。</Alert> : null}
              {devices.length > 1 ? (
                <Field label="选择麦克风" htmlFor="mic">
                  <Select id="mic" value={deviceId} onChange={(e) => onSelectDevice(e.target.value)}>
                    {devices.map((d, i) => (
                      <option key={d.deviceId || i} value={d.deviceId}>
                        {d.label || `麦克风 ${i + 1}`}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              <LevelMeter level={level} />
              <div className="space-y-2">
                <Button onClick={testRecord} disabled={testing} variant="secondary" data-testid="mic-test">
                  {testing ? (
                    <>
                      <Square className="h-4 w-4" /> 录音中… {countdown} 秒
                    </>
                  ) : (
                    <>
                      <Mic className="h-4 w-4" /> 录制 {TEST_SECONDS} 秒试音
                    </>
                  )}
                </Button>
                {testUrl ? (
                  <div className="space-y-2">
                    <audio controls src={testUrl} className="w-full" data-testid="mic-test-audio" />
                    {peak < 0.05 ? (
                      <Alert tone="warning">试音中几乎没有检测到声音。请确认选择了正确的麦克风，并靠近一些再试。</Alert>
                    ) : (
                      <p className="flex items-center gap-1.5 text-sm text-emerald-700">
                        <CheckCircle2 className="h-4 w-4" /> 已录到声音，请回放确认清晰。
                      </p>
                    )}
                  </div>
                ) : null}
                <p className="text-xs text-muted">当前浏览器录音格式：{pickMimeType() || "浏览器默认"}（服务器会统一转换）</p>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Headphones className="h-5 w-5 text-brand-600" /> 2. 考官声音
          </CardTitle>
          <CardDescription>建议佩戴耳机，避免考官声音被麦克风录进去。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button variant="secondary" onClick={testVoice} disabled={voice === "playing"} data-testid="voice-test">
            <Play className="h-4 w-4" /> {voice === "playing" ? "正在播放…" : "试听考官声音"}
          </Button>
          <p className="text-sm text-muted">当前考官：{voiceLabel}</p>
          {voice === "ok" ? <p className="text-sm text-emerald-700">播放完成。如果没有听到声音，请检查设备音量或静音开关。</p> : null}
          {voice === "failed" ? <Alert tone="warning">考官音频播放失败。面试中播放失败时会显示题目文字，你仍可以继续作答。</Alert> : null}
        </CardContent>
      </Card>

      <div className="md:col-span-2">
        <Button size="lg" disabled={!ready} onClick={() => router.push(next ?? "/")} data-testid="device-continue">
          {next ? "完成检查，继续" : "完成检查，返回首页"}
        </Button>
        {!ready ? <p className="mt-2 text-xs text-muted">完成麦克风检测后才能进入面试。</p> : null}
      </div>
    </div>
  );
}
