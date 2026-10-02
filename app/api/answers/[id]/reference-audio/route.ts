import { apiUser, handle, json } from "@/lib/auth-server";
import { getAnswerDetail } from "@/lib/services/answers";
import { ensureTtsAssets } from "@/lib/services/tts";
import { notFound } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const u = await apiUser(); const { id } = await ctx.params;
  const d = await getAnswerDetail(u, id);
  const sample = (d.feedback?.data as { sampleAnswer?: unknown } | undefined)?.sampleAnswer;
  const text = typeof sample === "string" ? sample : d.question?.content.referenceAnswer;
  if (typeof text !== "string" || !text) throw notFound("参考回答");
  const assets = await ensureTtsAssets([text]);
  return json({ ttsId: assets.get(text.trim()) });
});
