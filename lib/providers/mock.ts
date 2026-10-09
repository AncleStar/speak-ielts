import fs from "node:fs/promises";
import path from "node:path";
import { makeTempDir, makeToneWav, runProcess } from "@/lib/audio";
import { env } from "@/lib/env";
import { countWords } from "@/lib/feedback/validate";
import { mockThought } from "@/lib/thoughts/prompt";
import type { AsrInput, AsrResult, LlmInput, LlmResult, Providers, TtsResult } from "./types";

/**
 * 模拟服务模式（AI_PROVIDER=mock）：
 * - TTS：本地 espeak-ng；Windows 上可用系统语音；都不可用时生成提示音。
 * - ASR：有声音频返回演示文本，静音返回空结果。
 * - 反馈：按规则从转写中摘句生成，可通过证据校验。
 * 界面顶部固定显示"模拟服务模式"标识；模拟结果不计为真实能力验收。
 */

const DEMO_SENTENCES = [
  "Well, I think this is an interesting question for me.",
  "To be honest, I usually spend a lot of time on it, especially at the weekend.",
  "For example, last month I tried something new with my friends and it was really fun.",
  "The main reason is that it helps me relax after a busy day at school or work.",
  "I mean, it is not always easy, but I feel it is worth it in the long run.",
  "In my hometown, many people have similar habits, so it feels quite natural.",
  "So overall, I would say it plays an important part in my daily life.",
];

function hashSeed(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return Math.abs(h);
}

export function mockTranscript(hint: AsrInput["mockHint"]): string {
  const speech = hint?.speechSec ?? 0;
  if (speech < 0.5) return "";
  const target = Math.max(10, Math.round(speech * 2.2));
  const source = hint?.referenceText?.trim()
    ? hint.referenceText.trim()
    : DEMO_SENTENCES.slice(hashSeed(hint?.seed ?? "x") % 3).join(" ");
  const words = source.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let i = 0;
  while (out.length < target && words.length) {
    out.push(words[i % words.length]);
    i++;
    if (i >= words.length && out.length < target) {
      // 参考文本不够长时循环追加演示句
      words.push(...DEMO_SENTENCES.join(" ").split(/\s+/));
    }
  }
  let text = out.join(" ");
  if (!/[.!?]$/.test(text)) text += ".";
  return text;
}

function pickEvidence(transcript: string, fromWord: number, len: number) {
  const words = transcript.replace(/[.!?,;:]+/g, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const start = Math.min(fromWord, Math.max(0, words.length - len));
  return words.slice(start, start + len).join(" ");
}

export function mockFeedbackJson(hint: Record<string, unknown>) {
  const transcript = String(hint.transcript ?? "");
  const question = String(hint.question ?? "");
  const reference = String(hint.reference ?? "");
  const speechSec = Number(hint.speechSec ?? 0);
  const pauseCount = Number(hint.pauseCount ?? 0);
  const words = countWords(transcript);
  const met = words >= 20 && speechSec >= 3;
  const improvements = [
    {
      dimension: "lexical",
      issue: "（模拟反馈）可以把笼统的词换成更具体的表达。",
      evidence: pickEvidence(transcript, 6, 5),
      suggestion: "Try a more specific phrase, for example: \"what really matters to me is ...\"",
      explanation: "用具体的名词或动词代替 good、nice、thing 等笼统词，能让回答更清楚。",
    },
  ];
  if (pauseCount >= 2 || words > 40) {
    improvements.push({
      dimension: "fluency_coherence",
      issue: "（模拟反馈）观点之间可以加入衔接词。",
      evidence: pickEvidence(transcript, Math.floor(words / 2), 5),
      suggestion: "Link your ideas: \"On top of that, ...\" / \"That's why ...\"",
      explanation: "使用衔接词能让考官更容易跟上你的思路。",
    });
  }
  return {
    summary: `（模拟反馈）本次回答约 ${words} 个词，围绕“${question.slice(0, 60)}”作出了回应。以下内容为规则生成的演示数据。`,
    strengths: [
      {
        point: "（模拟反馈）开头直接回应了题目。",
        evidence: pickEvidence(transcript, 0, 5),
      },
    ],
    improvements,
    sampleAnswer: reference || "This is a demo sample answer generated in mock mode.",
    nextGoal: "（模拟反馈）下次作答时，在第二句补充一个具体例子。",
    goal: {
      met,
      reason: met ? "（模拟判断）回答长度足够，并对题目作出了回应。" : "（模拟判断）回答内容过少，难以体现本题目标。",
    },
    dimensions: {
      fluency_coherence: "（模拟）整体能连续表达，可增加衔接词。",
      lexical: "（模拟）词汇基本达意，可尝试更具体的表达。",
      grammar: "（模拟）句型较简单，可尝试使用从句。",
    },
  };
}

async function synthesizeWav(text: string): Promise<{ wav: Buffer; engine: string }> {
  const dir = await makeTempDir("ia-tts-");
  const out = path.join(dir, "out.wav");
  try {
    // 1) espeak-ng（Docker 镜像内置）
    try {
      const r = await runProcess(env().ESPEAK_PATH, ["-v", "en-us", "-s", "150", "-w", out, text], { timeoutMs: 30_000 });
      if (r.code === 0) return { wav: await fs.readFile(out), engine: "espeak-ng" };
    } catch {
      /* 不可用，继续尝试 */
    }
    // 2) Windows 系统语音（本机开发）
    if (process.platform === "win32") {
      const ps = [
        "Add-Type -AssemblyName System.Speech;",
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
        "$v = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'en-*' } | Select-Object -First 1;",
        "if ($v) { $s.SelectVoice($v.VoiceInfo.Name) };",
        "$s.Rate = -1;",
        `$s.SetOutputToWaveFile('${out.replace(/'/g, "''")}');`,
        "$t = [Console]::In.ReadToEnd();",
        "$s.Speak($t); $s.Dispose();",
      ].join(" ");
      try {
        const r = await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
          timeoutMs: 60_000,
          input: Buffer.from(text, "utf8"),
        });
        if (r.code === 0) {
          const wav = await fs.readFile(out);
          if (wav.length > 100) return { wav, engine: "windows-sapi" };
        }
      } catch {
        /* 不可用 */
      }
    }
    // 3) 提示音
    return { wav: makeToneWav(0.6), engine: "tone" };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function createMockProviders(): Providers {
  return {
    name: "mock",
    ttsKind: "mock",
    ttsIdentity: () => ({ model: "mock-local-tts", voice: "local-en" }),
    async asr(input: AsrInput): Promise<AsrResult> {
      const t0 = Date.now();
      const text = mockTranscript(input.mockHint);
      return { text, model: "mock-asr", seconds: input.durationSec, latencyMs: Date.now() - t0, mock: true };
    },
    async tts(text: string): Promise<TtsResult> {
      const t0 = Date.now();
      const { wav, engine } = process.env.MOCK_TTS_TONE === "true"
        ? { wav: makeToneWav(0.08), engine: "test-tone" }
        : await synthesizeWav(text);
      return {
        audio: wav,
        mime: "audio/wav",
        model: `mock-${engine}`,
        voice: "local-en",
        chars: text.length,
        latencyMs: Date.now() - t0,
        mock: true,
      };
    },
    async llmJson(input: LlmInput): Promise<LlmResult> {
      const t0 = Date.now();
      let json: unknown;
      if (input.purpose === "feedback") {
        json = mockFeedbackJson(input.mockHint ?? {});
      } else if (input.purpose === "thought") {
        json = mockThought(String(input.mockHint?.sourceText ?? ""));
      } else if (input.purpose === "followup") {
        const candidates = (input.mockHint?.candidates as string[]) ?? [];
        const transcript = String(input.mockHint?.transcript ?? "");
        const pick = candidates[countWords(transcript) % Math.max(1, candidates.length)] ?? candidates[0];
        json = { followUpId: pick, reason: "（模拟选择）" };
      } else {
        json = { ok: true, message: "mock" };
      }
      const raw = JSON.stringify(json);
      return {
        raw,
        json,
        model: "mock-llm",
        inputTokens: Math.round((input.system.length + input.user.length) / 3),
        outputTokens: Math.round(raw.length / 3),
        latencyMs: Date.now() - t0,
        mock: true,
      };
    },
  };
}
