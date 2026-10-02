// Public model metadata only. No keys or user configuration in this module.
export const AI_CATALOG = {
  provider: "阿里云百炼 · 中国内地（北京）",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  priceDate: "2026-10-01",
  asr: [
    { id: "qwen3-asr-flash-2026-02-10", label: "Qwen3 ASR · 2026-02-10", perSecond: 0.00022 },
    { id: "qwen3-asr-flash", label: "Qwen3 ASR · 稳定版", perSecond: 0.00022 },
  ],
  llm: [
    { id: "qwen-plus", label: "Qwen Plus · 均衡", inputPerMillion: 0.8, outputPerMillion: 2,
      tiers: [[128000, 0.8, 2], [256000, 2.4, 20], [1000000, 4.8, 48]] },
    { id: "qwen-flash", label: "Qwen Flash · 低成本", inputPerMillion: 0.15, outputPerMillion: 1.5,
      tiers: [[128000, 0.15, 1.5], [256000, 0.6, 6], [1000000, 1.2, 12]] },
  ],
  sources: {
    asr: "https://help.aliyun.com/zh/model-studio/qwen3-asr-flash",
    plus: "https://help.aliyun.com/zh/model-studio/qwen-plus",
    flash: "https://help.aliyun.com/zh/model-studio/qwen-flash",
  },
} as const;

export function personalPrice(model: string, inputTokens = 0) {
  const asr = AI_CATALOG.asr.find(m => m.id === model);
  if (asr) return { asrPerSecond: asr.perSecond };
  const llm = AI_CATALOG.llm.find(m => m.id === model);
  if (!llm) throw new Error("Unsupported personal model");
  const tier = llm.tiers.find(t => inputTokens <= t[0]) ?? llm.tiers[llm.tiers.length - 1];
  return { llmInputPerMTok: tier[1], llmOutputPerMTok: tier[2] };
}
