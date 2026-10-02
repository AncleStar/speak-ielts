import { eq } from "drizzle-orm";
import { ttsAsset } from "@/db/schema";
import { apiUser, handle } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { ensureTtsAssets, generateTtsAsset } from "@/lib/services/tts";
import { providers } from "@/lib/providers";
import { storage } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 考官音频（需登录）。尚未生成时按需生成一次。 */
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await apiUser({ allowMustChange: true });
  const { id } = await ctx.params;
  let [asset] = await db.select().from(ttsAsset).where(eq(ttsAsset.id, id));
  if (!asset) throw new AppError(404, "not_found", "音频不存在");
  const identity = providers().ttsIdentity();
  if (asset.model !== identity.model || asset.voice !== identity.voice) {
    const ids = await ensureTtsAssets([asset.text]);
    return new Response(null, { status: 307, headers: { Location: `/api/tts/${ids.get(asset.text)!}`, "Cache-Control": "no-store" } });
  }
  if (asset.status !== "ready") {
    try {
      await generateTtsAsset(id);
    } catch {
      throw new AppError(503, "tts_unavailable", "考官音频暂时不可用");
    }
    [asset] = await db.select().from(ttsAsset).where(eq(ttsAsset.id, id));
  }
  if (!asset?.storageKey) throw new AppError(503, "tts_unavailable", "考官音频暂时不可用");
  const st = storage();
  const url = await st.signedUrl(asset.storageKey, 600);
  if (url) return Response.redirect(url, 302);
  const buf = await st.get(asset.storageKey);
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": asset.mimeType ?? "audio/mpeg",
      "Content-Length": String(buf.length),
      "Cache-Control": "private, max-age=86400",
    },
  });
});
