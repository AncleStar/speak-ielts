import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { questionVersion, ttsAsset } from "@/db/schema";
import { isFfmpegAvailable, makeTempDir, toExaminerMp3 } from "@/lib/audio";
import { loadContent } from "@/lib/content/load";
import type { QuestionContent } from "@/lib/content/types";
import { db } from "@/lib/db";
import { logOps } from "@/lib/ops";
import { providers } from "@/lib/providers";
import { QUEUES, enqueue } from "@/lib/queue";
import { storage, ttsKey } from "@/lib/storage";
import { metered } from "@/lib/providers/metered";

export function ttsHash(text: string, model: string, voice: string) {
  return crypto.createHash("sha256").update(`${model}|${voice}|${text.trim()}`).digest("hex").slice(0, 40);
}

/** 为一组文本准备考官音频记录（不存在则创建 pending 并排队生成），返回 文本 → 资源编号。 */
export async function ensureTtsAssets(texts: string[], opts: { enqueueMissing?: boolean } = {}): Promise<Map<string, string>> {
  const { model, voice } = providers().ttsIdentity();
  const unique = [...new Set(texts.map((t) => t.trim()).filter(Boolean))];
  const byHash = new Map(unique.map((t) => [ttsHash(t, model, voice), t]));
  if (byHash.size === 0) return new Map();
  await db
    .insert(ttsAsset)
    .values([...byHash.entries()].map(([hash, text]) => ({ hash, text, model, voice, mock: providers().ttsKind === "mock" })))
    .onConflictDoNothing({ target: ttsAsset.hash });
  const rows = await db.select().from(ttsAsset).where(inArray(ttsAsset.hash, [...byHash.keys()]));
  const out = new Map<string, string>();
  const missing: string[] = [];
  for (const r of rows) {
    out.set(r.text, r.id);
    if (r.status !== "ready") missing.push(r.id);
  }
  if (opts.enqueueMissing !== false) {
    for (const id of missing) {
      await enqueue(QUEUES.tts, { assetId: id }).catch((e) => console.error("[tts] 排队失败", (e as Error).message));
    }
  }
  return out;
}

const inflight = new Map<string, Promise<void>>();

/** 生成并转存一条考官音频；已就绪则跳过。 */
export async function generateTtsAsset(assetId: string, opts: { force?: boolean } = {}): Promise<void> {
  const existing = inflight.get(assetId);
  if (existing) return existing;
  const p = (async () => {
    const [asset] = await db.select().from(ttsAsset).where(eq(ttsAsset.id, assetId));
    if (!asset) return;
    const identity = providers().ttsIdentity();
    // 切换音色后不让旧队列把新声音写入旧模型/音色的缓存。
    if (asset.model !== identity.model || asset.voice !== identity.voice) return;
    if (asset.status === "ready" && !opts.force) return;
    const [claimed] = await db.update(ttsAsset).set({ status: "generating", updatedAt: new Date() })
      .where(and(eq(ttsAsset.id, assetId), sql`(${ttsAsset.status} <> 'generating' or ${ttsAsset.updatedAt} < ${new Date(Date.now() - 300000)})`, opts.force ? undefined : ne(ttsAsset.status, "ready")))
      .returning({ id: ttsAsset.id });
    if (!claimed) {
      // web 按需生成与 worker 预生成共享数据库租约，避免重复付费。
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const [current] = await db.select({ status: ttsAsset.status }).from(ttsAsset).where(eq(ttsAsset.id, assetId));
        if (current?.status === "ready") return;
        if (!current || current.status === "failed") throw new Error("考官音频生成失败，请重试");
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new Error("考官音频正在生成，请稍后重试");
    }
    const t0 = Date.now();
    try {
      const r = await metered(`tts:${assetId}`).tts(asset.text);
      let audio = r.audio;
      let mime = r.mime;
      let ext = mime.includes("mpeg") ? "mp3" : "wav";
      if (ext !== "mp3" && (await isFfmpegAvailable())) {
        const dir = await makeTempDir("ia-tts-");
        try {
          const inFile = path.join(dir, `in.${ext}`);
          const outFile = path.join(dir, "out.mp3");
          await fs.writeFile(inFile, audio);
          await toExaminerMp3(inFile, outFile);
          audio = await fs.readFile(outFile);
          mime = "audio/mpeg";
          ext = "mp3";
        } finally {
          await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }
      const key = ttsKey(asset.hash, ext);
      await storage().put(key, audio, mime);
      await db
        .update(ttsAsset)
        .set({ status: "ready", storageKey: key, mimeType: mime, error: null, mock: r.mock, updatedAt: new Date() })
        .where(eq(ttsAsset.id, assetId));
      await logOps("info", "tts", assetId, `考官音频已生成（${r.model}）`, Date.now() - t0);
    } catch (e) {
      await db
        .update(ttsAsset)
        .set({ status: "failed", error: (e as Error).message.slice(0, 500), updatedAt: new Date() })
        .where(eq(ttsAsset.id, assetId));
      await logOps("error", "tts", assetId, `考官音频生成失败：${(e as Error).message}`, Date.now() - t0);
      throw e;
    }
  })();
  inflight.set(assetId, p);
  try {
    await p;
  } finally {
    inflight.delete(assetId);
  }
}

export function questionTexts(c: QuestionContent): string[] {
  const out = [c.text];
  if (c.topicIntro) out.push(c.topicIntro);
  for (const f of c.followUps ?? []) out.push(f.text);
  for (const r of c.roundingOff ?? []) out.push(r.text);
  return out;
}

/** 为所有已发布题目与考官固定用语准备音频（题目发布时调用）。 */
export async function pregenerateAll(opts: { versionIds?: string[] } = {}) {
  const content = loadContent();
  const texts: string[] = Object.values(content.phrases);
  const rows = await db
    .select({ content: questionVersion.content })
    .from(questionVersion)
    .where(opts.versionIds?.length ? inArray(questionVersion.id, opts.versionIds) : eq(questionVersion.published, true));
  for (const r of rows) texts.push(...questionTexts(r.content as QuestionContent));
  const ids = await ensureTtsAssets(texts);
  return { total: ids.size };
}

export async function ttsStatusCounts() {
  const rows = await db.select({ status: ttsAsset.status, model: ttsAsset.model, voice: ttsAsset.voice }).from(ttsAsset);
  const { model, voice, label } = providers().ttsIdentity();
  const current = rows.filter((r) => r.model === model && r.voice === voice);
  return {
    model,
    voice,
    label,
    ready: current.filter((r) => r.status === "ready").length,
    pending: current.filter((r) => r.status === "pending" || r.status === "generating").length,
    failed: current.filter((r) => r.status === "failed").length,
    otherModels: rows.length - current.length,
  };
}

export async function retryFailedTts() {
  const { model, voice } = providers().ttsIdentity();
  const rows = await db
    .select({ id: ttsAsset.id })
    .from(ttsAsset)
    .where(and(eq(ttsAsset.model, model), eq(ttsAsset.voice, voice), ne(ttsAsset.status, "ready")));
  for (const r of rows) await enqueue(QUEUES.tts, { assetId: r.id });
  return rows.length;
}
