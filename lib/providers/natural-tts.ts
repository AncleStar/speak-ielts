import path from "node:path";
import type { KokoroTTS } from "kokoro-js";
import { dataDir, env } from "@/lib/env";
import { ProviderError, type TtsResult } from "./types";
import { ensureNaturalVoiceCache, NATURAL_MODEL_ID, NATURAL_MODEL_TAG, NATURAL_REVISION, VoiceCacheError, type VoiceCacheOptions } from "./natural-voice-cache";

const VOICE_LABELS = {
  bf_emma: "Emma · 英式女声", bf_isabella: "Isabella · 英式女声",
  bm_george: "George · 英式男声", af_heart: "Heart · 美式女声",
};

export function naturalVoiceIdentity() {
  const e = env();
  return { model: NATURAL_MODEL_TAG, voice: `${e.LOCAL_TTS_VOICE}@${e.LOCAL_TTS_SPEED.toFixed(2)}-v1`, label: VOICE_LABELS[e.LOCAL_TTS_VOICE] };
}

let engine: Promise<KokoroTTS> | undefined;

/** 模型只在显式 setup:voice 时联网下载；面试期间完全从本机缓存加载。 */
export function prepareNaturalVoice(allowDownload = false, options: Omit<VoiceCacheOptions, "allowDownload" | "files" | "fetchFile"> = {}): Promise<KokoroTTS> {
  if (!engine) {
    engine = (async () => {
      const cache = path.join(dataDir(), "models");
      await ensureNaturalVoiceCache(cache, { ...options, allowDownload });
      const [{ KokoroTTS }, { AutoTokenizer, StyleTextToSpeech2Model }] = await Promise.all([
        import("kokoro-js"), import("@huggingface/transformers"),
      ]);
      const loadOptions = { revision: NATURAL_REVISION, cache_dir: cache, local_files_only: true };
      const [model, tokenizer] = await Promise.all([
        StyleTextToSpeech2Model.from_pretrained(NATURAL_MODEL_ID, {
          ...loadOptions, dtype: "q8", device: "cpu",
          session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
        }),
        AutoTokenizer.from_pretrained(NATURAL_MODEL_ID, loadOptions),
      ]);
      return new KokoroTTS(model, tokenizer);
    })().catch((error) => {
      engine = undefined;
      if (error instanceof VoiceCacheError) throw error;
      throw new ProviderError("自然语音模型加载失败，请部署者检查缓存、依赖和配置后重新运行 npm run setup:voice。", true);
    });
  }
  return engine;
}

/** 按句子、必要时按词分段，避免长参考答案超过模型长度后被静默截断。 */
export function speechChunks(text: string): string[] {
  const segments = new Intl.Segmenter("en-GB", { granularity: "sentence" }).segment(text.trim());
  const chunks: string[] = [];
  for (const { segment } of segments) {
    let chunk = "";
    for (const word of segment.trim().split(/\s+/)) {
      if (word.length > 280) throw new ProviderError("朗读文本包含过长的连续字符，请检查题目。", false);
      if (chunk && chunk.length + word.length + 1 > 280) { chunks.push(chunk); chunk = ""; }
      chunk = chunk ? `${chunk} ${word}` : word;
    }
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

// phonemizer 使用共享 WASM 状态；每个进程串行合成，限制 CPU 和内存峰值。
let generation: Promise<unknown> = Promise.resolve();
export function naturalTts(text: string): Promise<TtsResult> {
  const task = generation.then(async () => {
    const started = Date.now();
    const chunks = speechChunks(text);
    if (!chunks.length) throw new ProviderError("朗读文本不能为空。", false);
    const tts = await prepareNaturalVoice();
    const { RawAudio } = await import("@huggingface/transformers");
    const e = env();
    const parts: Float32Array[] = [];
    for (const chunk of chunks) {
      if (parts.length) parts.push(new Float32Array(24000 * 0.16));
      const audio = await tts.generate(chunk, { voice: e.LOCAL_TTS_VOICE, speed: e.LOCAL_TTS_SPEED });
      parts.push(audio.audio);
    }
    const samples = new Float32Array(parts.reduce((n, part) => n + part.length, 0));
    let offset = 0;
    for (const part of parts) { samples.set(part, offset); offset += part.length; }
    return {
      ...naturalVoiceIdentity(), audio: Buffer.from(new RawAudio(samples, 24000).toWav()), mime: "audio/wav",
      chars: text.length, latencyMs: Date.now() - started, mock: false,
    };
  });
  generation = task.catch(() => {});
  return task;
}

export async function disposeNaturalVoice() {
  await generation;
  if (engine) await (await engine).model.dispose();
  engine = undefined;
}
