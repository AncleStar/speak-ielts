import { env, type Env } from "@/lib/env";
import type { AsrInput, AsrResult, LlmInput, LlmResult, OmniResult, Providers, TtsResult } from "./types";
import { ProviderError } from "./types";

/**
 * 阿里云百炼（中国内地·北京）：
 * - ASR：qwen3-asr-flash，OpenAI 兼容接口，音频以 Base64 data URI 传入（≤10 MB、≤5 分钟）
 * - TTS：qwen3-tts-flash，原生接口，返回 24 小时有效的音频 URL → 立即下载转存
 * - LLM：qwen-plus，非思考模式 + JSON Object 结构化输出
 * - Omni：实验性音频诊断，默认关闭
 */

function nativeBase(e: Env) {
  if (e.DASHSCOPE_NATIVE_BASE_URL) return e.DASHSCOPE_NATIVE_BASE_URL.replace(/\/$/, "");
  return e.DASHSCOPE_BASE_URL.replace(/\/compatible-mode\/v1\/?$/, "/api/v1").replace(/\/$/, "");
}

async function fetchJson(url: string, body: unknown, timeoutMs: number, key: string): Promise<unknown> {
  if (!key) throw new ProviderError("DASHSCOPE_API_KEY 未配置", false);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch {
    throw new ProviderError("百炼连接失败或超时，请稍后重试。", true);
  }
  const text = await res.text();
  if (!res.ok) {
    // 不在错误信息中回显请求内容
    throw new ProviderError(`百炼接口返回 ${res.status}（请核对模型权限、服务地址和额度）`, res.status >= 500 || res.status === 429, res.status);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError("百炼接口返回了无法解析的内容", true, res.status);
  }
}

type ChatResponse = {
  choices?: { message?: { content?: string | { text?: string }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number; seconds?: number };
};

function messageText(r: ChatResponse): string {
  const c = r.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => x.text ?? "").join("");
  return "";
}

export function createDashscopeProviders(overrides: Partial<Pick<Env, "DASHSCOPE_API_KEY" | "DASHSCOPE_BASE_URL" | "ASR_MODEL" | "LLM_MODEL">> = {}): Providers {
  const e = { ...env(), ...overrides };
  const compatBase = () => e.DASHSCOPE_BASE_URL.replace(/\/$/, "");
  const postJson = (url: string, body: unknown, timeoutMs: number) => fetchJson(url, body, timeoutMs, e.DASHSCOPE_API_KEY);
  return {
    name: "dashscope",
    ttsKind: "cloud",
    ttsIdentity: () => ({ model: e.TTS_MODEL, voice: e.TTS_VOICE }),

    async asr(input: AsrInput): Promise<AsrResult> {
      const t0 = Date.now();
      const fmt = input.mime.includes("mpeg") ? "mp3" : "wav";
      const dataUri = `data:audio/${fmt};base64,${input.audio.toString("base64")}`;
      const r = (await postJson(
        `${compatBase()}/chat/completions`,
        {
          model: e.ASR_MODEL,
          messages: [
            { role: "system", content: [{ type: "text", text: "" }] },
            { role: "user", content: [{ type: "input_audio", input_audio: { data: dataUri } }] },
          ],
          stream: false,
          asr_options: { language: "en", enable_itn: false },
        },
        90_000,
      )) as ChatResponse;
      return {
        text: messageText(r).trim(),
        model: e.ASR_MODEL,
        seconds: typeof r.usage?.seconds === "number" && Number.isFinite(r.usage.seconds) && r.usage.seconds >= 0 ? r.usage.seconds : input.durationSec,
        usageEstimated: !(typeof r.usage?.seconds === "number" && Number.isFinite(r.usage.seconds) && r.usage.seconds >= 0),
        latencyMs: Date.now() - t0,
        mock: false,
      };
    },

    async tts(text: string): Promise<TtsResult> {
      const t0 = Date.now();
      const r = (await postJson(
        `${nativeBase(e)}/services/aigc/multimodal-generation/generation`,
        { model: e.TTS_MODEL, input: { text, voice: e.TTS_VOICE, language_type: "English" } },
        60_000,
      )) as { output?: { audio?: { url?: string; data?: string } }; usage?: { characters?: number } };
      const url = r.output?.audio?.url;
      let audio: Buffer;
      if (url) {
        // 返回的 URL 24 小时后失效，立即下载
        const dl = await fetch(url, { signal: AbortSignal.timeout(60_000) }).catch((err) => {
          throw new ProviderError(`下载考官音频失败：${(err as Error).message}`, true);
        });
        if (!dl.ok) throw new ProviderError(`下载考官音频失败：${dl.status}`, true, dl.status);
        audio = Buffer.from(await dl.arrayBuffer());
      } else if (r.output?.audio?.data) {
        audio = Buffer.from(r.output.audio.data, "base64");
      } else {
        throw new ProviderError("语音合成未返回音频", true);
      }
      return {
        audio,
        mime: "audio/wav",
        model: e.TTS_MODEL,
        voice: e.TTS_VOICE,
        chars: r.usage?.characters ?? text.length,
        latencyMs: Date.now() - t0,
        mock: false,
      };
    },

    async llmJson(input: LlmInput): Promise<LlmResult> {
      const t0 = Date.now();
      const r = (await postJson(
        `${compatBase()}/chat/completions`,
        {
          model: e.LLM_MODEL,
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
          ],
          response_format: { type: "json_object" },
          enable_thinking: false,
          temperature: 0.3,
          max_tokens: input.maxTokens ?? 1800,
        },
        input.timeoutMs ?? 60_000,
      )) as ChatResponse;
      const raw = messageText(r);
      let json: unknown = null;
      try {
        json = JSON.parse(raw);
      } catch {
        json = null;
      }
      return {
        raw,
        json,
        model: e.LLM_MODEL,
        inputTokens: r.usage?.prompt_tokens ?? r.usage?.input_tokens ?? Buffer.byteLength(input.system + input.user) + 1024,
        outputTokens: r.usage?.completion_tokens ?? r.usage?.output_tokens ?? Buffer.byteLength(raw),
        usageEstimated: (r.usage?.prompt_tokens ?? r.usage?.input_tokens) === undefined || (r.usage?.completion_tokens ?? r.usage?.output_tokens) === undefined,
        latencyMs: Date.now() - t0,
        mock: false,
      };
    },

    async omniAudio(input): Promise<OmniResult> {
      const t0 = Date.now();
      const fmt = input.mime.includes("mpeg") ? "mp3" : "wav";
      const r = (await postJson(
        `${compatBase()}/chat/completions`,
        {
          model: e.OMNI_MODEL,
          messages: [
            {
              role: "user",
              content: [
                { type: "input_audio", input_audio: { data: `data:audio/${fmt};base64,${input.audio.toString("base64")}`, format: fmt } },
                { type: "text", text: input.prompt },
              ],
            },
          ],
          modalities: ["text"],
          stream: false,
          max_tokens: 600,
        },
        90_000,
      )) as ChatResponse;
      return {
        text: messageText(r),
        model: e.OMNI_MODEL,
        inputTokens: r.usage?.prompt_tokens ?? 0,
        outputTokens: r.usage?.completion_tokens ?? 0,
        latencyMs: Date.now() - t0,
      };
    },
  };
}
