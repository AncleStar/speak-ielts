import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { env } from "@/lib/env";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** ASR 单次请求上限 10 MB（Base64 后） */
export const ASR_MAX_BASE64_BYTES = 10 * 1024 * 1024;

export type AudioKind = { ext: "webm" | "mp4" | "ogg" | "wav" | "mp3"; mime: string };

/** 按文件头识别实际音频类型（不信任客户端声明的 Content-Type）。 */
export function detectAudioType(buf: Uint8Array): AudioKind | null {
  if (buf.length < 12) return null;
  const ascii = (start: number, len: number) => String.fromCharCode(...buf.subarray(start, start + len));
  // WebM / Matroska: 1A 45 DF A3
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { ext: "webm", mime: "audio/webm" };
  // MP4 / M4A: ....ftyp
  if (ascii(4, 4) === "ftyp") return { ext: "mp4", mime: "audio/mp4" };
  // Ogg: OggS
  if (ascii(0, 4) === "OggS") return { ext: "ogg", mime: "audio/ogg" };
  // WAV: RIFF....WAVE
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return { ext: "wav", mime: "audio/wav" };
  // MP3: ID3 或帧同步
  if (ascii(0, 3) === "ID3" || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return { ext: "mp3", mime: "audio/mpeg" };
  return null;
}

export function runProcess(cmd: string, args: string[], opts: { timeoutMs?: number; input?: Buffer } = {}) {
  return new Promise<{ code: number; stdout: Buffer; stderr: string }>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${path.basename(cmd)} 超时`));
    }, opts.timeoutMs ?? 120_000);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => {
      err += d.toString();
      if (err.length > 2_000_000) err = err.slice(-1_000_000);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err });
    });
    if (opts.input) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

async function ffmpeg(args: string[], timeoutMs = 120_000) {
  const r = await runProcess(env().FFMPEG_PATH, ["-hide_banner", "-nostdin", ...args], { timeoutMs });
  if (r.code !== 0) throw new Error(`ffmpeg 失败（${r.code}）：${r.stderr.split("\n").slice(-4).join(" ").trim()}`);
  return r;
}

export async function isFfmpegAvailable(): Promise<boolean> {
  try {
    const r = await runProcess(env().FFMPEG_PATH, ["-version"], { timeoutMs: 10_000 });
    return r.code === 0;
  } catch {
    return false;
  }
}

export async function makeTempDir(prefix = "ia-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** 转为单声道 16 kHz 16-bit PCM WAV */
export async function transcodeToWav(input: string, output: string) {
  await ffmpeg(["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", output]);
}

/** 转为 48 kbps MP3（ASR 超限时的备选） */
export async function transcodeToMp3(input: string, output: string, bitrate = "48k") {
  await ffmpeg(["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", bitrate, output]);
}

/** 考官音频统一转为 MP3（体积小，各浏览器可播放） */
export async function toExaminerMp3(input: string, output: string) {
  await ffmpeg(["-y", "-i", input, "-vn", "-ac", "1", "-ar", "24000", "-b:a", "64k", output]);
}

/** 读取 16-bit PCM WAV 的时长（秒） */
export function wavDurationSec(buf: Buffer): number {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") return 0;
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") byteRate = buf.readUInt32LE(offset + 16);
    if (id === "data") {
      const dataSize = Math.min(size, buf.length - offset - 8);
      return byteRate > 0 ? dataSize / byteRate : 0;
    }
    offset += 8 + size + (size % 2);
  }
  return 0;
}

export interface SilenceInterval {
  start: number;
  end: number;
}

/** 解析 ffmpeg silencedetect 输出 */
export function parseSilenceDetect(stderr: string, durationSec: number): SilenceInterval[] {
  const out: SilenceInterval[] = [];
  let pending: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) {
      pending = Math.max(0, Number(s[1]));
      continue;
    }
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (e && pending !== null) {
      out.push({ start: pending, end: Math.min(durationSec, Number(e[1])) });
      pending = null;
    }
  }
  if (pending !== null) out.push({ start: pending, end: durationSec });
  return out.filter((x) => x.end > x.start);
}

export interface AudioMetrics {
  durationSec: number;
  /** 有效作答时长：扣除超过 1 秒的静音 */
  speechSec: number;
  silenceSec: number;
  /** 回答中间超过 1 秒的停顿次数（不含开头与结尾的静音） */
  pauseCount: number;
  longestPauseSec: number;
  leadingSilenceSec: number;
  wordsPerMinute: number | null;
}

/** 由静音区间计算停顿指标（纯函数，便于测试） */
export function computeMetrics(durationSec: number, silences: SilenceInterval[], minPause = 1): AudioMetrics {
  const long = silences.filter((s) => s.end - s.start >= minPause);
  const silenceSec = long.reduce((a, s) => a + (s.end - s.start), 0);
  const eps = 0.05;
  const internal = long.filter((s) => s.start > eps && s.end < durationSec - eps);
  const leading = long.find((s) => s.start <= eps);
  return {
    durationSec: round1(durationSec),
    speechSec: round1(Math.max(0, durationSec - silenceSec)),
    silenceSec: round1(silenceSec),
    pauseCount: internal.length,
    longestPauseSec: round1(internal.reduce((m, s) => Math.max(m, s.end - s.start), 0)),
    leadingSilenceSec: round1(leading ? leading.end - leading.start : 0),
    wordsPerMinute: null,
  };
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

/** 静音检测：噪声阈值 -35 dB、最短 1 秒 */
export async function analyzeWav(wavPath: string): Promise<AudioMetrics> {
  const buf = await fs.readFile(wavPath);
  const duration = wavDurationSec(buf);
  const r = await ffmpeg(["-i", wavPath, "-af", "silencedetect=noise=-35dB:d=1", "-f", "null", "-"]);
  return computeMetrics(duration, parseSilenceDetect(r.stderr, duration));
}

/** 生成提示音 WAV（模拟模式下 TTS 不可用时使用） */
export function makeToneWav(durationSec = 0.6, freq = 660, sampleRate = 16000): Buffer {
  const n = Math.floor(durationSec * sampleRate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, i / 400, (n - i) / 400);
    const v = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.3 * fade;
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return wrapPcmWav(data, sampleRate);
}

export function wrapPcmWav(pcm: Buffer, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
