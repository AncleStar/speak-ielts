"use client";

import { useEffect, useRef } from "react";
import type { MicRecorder } from "@/lib/client/recorder";

/** 实时声音波形（读取录音器的分析节点） */
export function Waveform({ recorder, active, className }: { recorder: MicRecorder | null; active: boolean; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      c.width = c.clientWidth * dpr;
      c.height = c.clientHeight * dpr;
    };
    resize();
    const buf = new Uint8Array(new ArrayBuffer(1024));
    const draw = () => {
      const w = c.width;
      const h = c.height;
      ctx.clearRect(0, 0, w, h);
      const an = recorder?.analyser;
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = active ? "#996413" : "#c5c3ba";
      ctx.lineCap = "round";
      ctx.beginPath();
      if (an) {
        an.getByteTimeDomainData(buf.subarray(0, an.fftSize));
        const n = an.fftSize;
        const bars = Math.max(24, Math.min(72, Math.floor(w/(7*dpr))));
        for (let i = 0; i < bars; i++) {
          const start = Math.floor(i*n/bars), end = Math.floor((i+1)*n/bars);
          let energy = 0;
          for (let j=start;j<end;j++) energy += Math.pow((buf[j]-128)/128,2);
          const amplitude = Math.sqrt(energy/Math.max(1,end-start));
          const length = Math.max(2*dpr, Math.min(h*.85, amplitude*h*4));
          const x = (i+.5)*w/bars;
          ctx.moveTo(x,h/2-length/2);ctx.lineTo(x,h/2+length/2);
        }
      } else {
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
      }
      ctx.stroke();
      raf = requestAnimationFrame(draw);
    };
    draw();
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [recorder, active]);
  return <canvas ref={canvas} className={className ?? "h-16 w-full"} aria-hidden />;
}

/** 简易音量条（设备检查用） */
export function LevelMeter({ level }: { level: number }) {
  const bars = 20;
  const lit = Math.round(level * bars);
  return (
    <div className="flex h-6 items-end gap-1" aria-label={`当前音量 ${Math.round(level * 100)}%`}>
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          className={i < lit ? (i > 16 ? "bg-red-500" : i > 12 ? "bg-amber-500" : "bg-emerald-500") : "bg-slate-200"}
          style={{ width: 6, height: `${30 + (i / bars) * 70}%`, borderRadius: 2 }}
        />
      ))}
    </div>
  );
}

