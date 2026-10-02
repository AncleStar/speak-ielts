import { env } from "@/lib/env";
import { billableCall } from "@/lib/usage";
import { providers } from "./index";
import type { AsrInput, LlmInput } from "./types";
import { resolveUserAi } from "@/lib/ai/runtime";

export function metered(jobRef: string, userId?: string) {
  const p = providers();
  const common = { jobRef, userId, mock: p.name === "mock" };
  return {
    asr: async (input: AsrInput) => {
      const ai = await resolveUserAi(userId);
      return billableCall({ ...common, mock: ai.provider.name === "mock", billingSource: ai.source, monthlyBudgetYuan: ai.monthlyBudgetYuan, service: "asr", model: ai.asrModel,
        estimate: { seconds: Math.ceil(input.durationSec) }, run: () => ai.provider.asr(input), units: r => ({ seconds: Math.ceil(r.seconds), estimated: r.usageEstimated ?? r.mock }) });
    },
    tts: (text: string) => billableCall({ ...common, mock: p.ttsKind === "mock", billable: p.ttsKind === "cloud", service: "tts", model: p.ttsIdentity().model,
      estimate: { chars: Buffer.byteLength(text) }, run: () => p.tts(text), units: r => ({ chars: r.chars }) }),
    llmJson: async (input: LlmInput) => {
      const ai = await resolveUserAi(userId);
      return billableCall({ ...common, mock: ai.provider.name === "mock", billingSource: ai.source, monthlyBudgetYuan: ai.monthlyBudgetYuan, service: "llm", model: ai.llmModel,
        estimate: { inputTokens: Buffer.byteLength(input.system + input.user) + 1024, outputTokens: input.maxTokens ?? 1800 },
        run: () => ai.provider.llmJson(input), units: r => ({ inputTokens: r.inputTokens, outputTokens: r.outputTokens, estimated: r.usageEstimated ?? r.mock }) });
    },
    omniAudio: (input: { audio: Buffer; mime: string; prompt: string }) => billableCall({ ...common, service: "omni", model: env().OMNI_MODEL,
      estimate: { inputTokens: Math.ceil(input.audio.length / 32000 * 100) + Buffer.byteLength(input.prompt) + 1024, outputTokens: 600 },
      run: () => p.omniAudio!(input), units: r => ({ inputTokens: r.inputTokens, outputTokens: r.outputTokens }) }),
  };
}
