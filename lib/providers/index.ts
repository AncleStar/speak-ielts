import { env } from "@/lib/env";
import { createDashscopeProviders } from "./dashscope";
import { createMockProviders } from "./mock";
import { naturalTts, naturalVoiceIdentity } from "./natural-tts";
import type { Providers } from "./types";

let current: Providers | null = null;

/** 转写/反馈和考官语音分别选择提供者。 */
export function providers(): Providers {
  if (!current) {
    current = env().AI_PROVIDER === "dashscope" ? createDashscopeProviders() : createMockProviders();
    const ttsProvider = env().TTS_PROVIDER;
    if (ttsProvider === "kokoro") {
      current = { ...current, ttsKind: "local", tts: naturalTts, ttsIdentity: naturalVoiceIdentity };
    } else if (ttsProvider !== "auto") {
      const voice = ttsProvider === "dashscope" ? createDashscopeProviders() : createMockProviders();
      current = { ...current, ttsKind: voice.ttsKind, tts: voice.tts, ttsIdentity: voice.ttsIdentity };
    }
  }
  return current;
}

/** 测试用：替换提供者实现 */
export function setProvidersForTest(p: Providers | null) {
  current = p;
}

export { ProviderError } from "./types";
export type { Providers } from "./types";
