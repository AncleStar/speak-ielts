import { apiUser, handle } from "@/lib/auth-server";
import { AppError } from "@/lib/errors";
import { ensureTtsAssets, generateTtsAsset, getTtsAssetForViewer } from "@/lib/services/tts";
import { providers } from "@/lib/providers";
import { storage } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 考官音频（需登录）。尚未生成时按需生成一次。 */
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const viewer = await apiUser({ allowMustChange: true });
  const { id } = await ctx.params;
  let asset = await getTtsAssetForViewer(viewer, id);
  if (asset.isPrivate) await apiUser();
  const identity = providers().ttsIdentity();
  if (asset.model !== identity.model || asset.voice !== identity.voice) {
    const ids = await ensureTtsAssets([asset.text], { answerId: asset.isPrivate ? asset.answerId! : undefined });
    return new Response(null, { status: 307, headers: { Location: `/api/tts/${ids.get(asset.text)!}`, "Cache-Control": "no-store" } });
  }
  if (asset.status !== "ready") {
    try {
      await generateTtsAsset(id);
    } catch {
      throw new AppError(503, "tts_unavailable", "考官音频暂时不可用");
    }
    asset = await getTtsAssetForViewer(viewer, id);
  }
  if (!asset?.storageKey) throw new AppError(503, "tts_unavailable", "考官音频暂时不可用");
  const st = storage();
  // Personalized speech stays behind application authorization, including on OSS.
  const url = asset.isPrivate ? null : await st.signedUrl(asset.storageKey, 600);
  if (url) {
    await getTtsAssetForViewer(viewer, id);
    return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store" } });
  }
  const buf = await st.get(asset.storageKey);
  await getTtsAssetForViewer(viewer, id);
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": asset.mimeType ?? "audio/mpeg",
      "Content-Length": String(buf.length),
      "Cache-Control": asset.isPrivate ? "no-store" : "private, max-age=86400",
    },
  });
});
