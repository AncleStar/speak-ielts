export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface AsrInput {
  audio: Buffer;
  /** audio/wav 或 audio/mpeg */
  mime: string;
  durationSec: number;
  /** 仅模拟模式使用：生成演示文本的参考 */
  mockHint?: { speechSec: number; referenceText?: string; seed?: string };
}

export interface AsrResult {
  usageEstimated?: boolean;
  text: string;
  model: string;
  seconds: number;
  latencyMs: number;
  mock: boolean;
}

export interface TtsResult {
  audio: Buffer;
  /** 原始音频类型（wav / mp3） */
  mime: string;
  model: string;
  voice: string;
  chars: number;
  latencyMs: number;
  mock: boolean;
}

export interface LlmInput {
  purpose: "feedback" | "followup" | "check" | "thought";
  system: string;
  user: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** 仅模拟模式使用：按规则生成结果 */
  mockHint?: Record<string, unknown>;
}

export interface LlmResult {
  usageEstimated?: boolean;
  raw: string;
  json: unknown;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  mock: boolean;
}

export interface OmniResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface Providers {
  name: "mock" | "dashscope";
  /** TTS 可独立于转写/反馈使用本地神经语音。 */
  ttsKind: "mock" | "local" | "cloud";
  asr(input: AsrInput): Promise<AsrResult>;
  tts(text: string): Promise<TtsResult>;
  llmJson(input: LlmInput): Promise<LlmResult>;
  /** 实验性音频诊断（ENABLE_AUDIO_DIAGNOSIS） */
  omniAudio?(input: { audio: Buffer; mime: string; prompt: string }): Promise<OmniResult>;
  /** 用于区分考官音频缓存的模型/音色标签 */
  ttsIdentity(): { model: string; voice: string; label?: string };
}
