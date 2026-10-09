import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth-server";
import { AppError } from "@/lib/errors";
import { env } from "@/lib/env";
import { getAiConfig } from "@/lib/ai/credentials";
import { getThought, listThoughts } from "@/lib/services/thoughts";
import { ThoughtLab } from "@/components/thoughts/thought-lab";
export const metadata: Metadata = { title: "个人观点实验室" };
export default async function ThoughtPage({ searchParams }: { searchParams: Promise<{ thought?: string; practice?: string }> }) {
  const u = await requireUser(); const params = await searchParams;
  const [initial, config] = await Promise.all([listThoughts(u.id), getAiConfig(u.id)]);
  let selected = null;
  if (params.thought) { try { selected = await getThought(u.id, params.thought); } catch (e) { if (e instanceof AppError && e.status === 404) notFound(); throw e; } }
  const modelLabel = config?.mode === "personal" ? `${config.llmModel} / ${config.keyCiphertext ? "个人 API" : "等待个人密钥"}`
    : env().AI_PROVIDER === "mock" ? "模拟模式 / 固定示例" : `${env().LLM_MODEL} / 站点 API`;
  return <ThoughtLab initial={initial} selected={selected} practiceInitially={params.practice === "1"} modelLabel={modelLabel} />;
}
