import { Readable } from "node:stream";
import { apiUser, handle, json } from "@/lib/auth-server";
import { MAX_UPLOAD_BYTES } from "@/lib/audio";
import { AppError } from "@/lib/errors";
import { getAnswerAudio, receiveAudio } from "@/lib/services/answers";
import { storage } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

/** 凭上传凭证接收录音（经应用服务器中转写入私有存储），校验大小与实际类型 */
export const PUT = handle(async (req: Request, ctx: Ctx) => {
  const u = await apiUser();
  const { id } = await ctx.params;
  const ticket = new URL(req.url).searchParams.get("ticket") ?? "";
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_UPLOAD_BYTES) throw new AppError(413, "too_large", "录音文件超过 25 MB");
  const reader = req.body?.getReader();
  if (!reader) throw new AppError(400, "empty_audio", "录音为空");
  const chunks: Buffer[] = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > MAX_UPLOAD_BYTES) { await reader.cancel(); throw new AppError(413, "too_large", "录音文件超过 25 MB"); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  const buf = Buffer.concat(chunks, total);
  return json(await receiveAudio(u.id, id, ticket, buf));
});

/** 鉴权后的录音回放：OSS 为 5 分钟签名链接；本地存储支持 Range 请求（Safari 播放需要） */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const u = await apiUser();
  const { id } = await ctx.params;
  const a = await getAnswerAudio(u, id);
  if (a.url) return Response.redirect(a.url, 302);
  const st = storage();
  const stat = await st.stat(a.key);
  if (!stat) throw new AppError(410, "audio_expired", "录音文件不存在");
  const range = req.headers.get("range");
  const headers: Record<string, string> = {
    "Content-Type": a.mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
  };
  if (range) {
    const m = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!m || (!m[1] && !m[2])) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } });
    let start = m?.[1] ? Number(m[1]) : 0;
    let end = m?.[2] ? Number(m[2]) : stat.size - 1;
    if (!m?.[1] && m?.[2]) {
      start = Math.max(0, stat.size - Number(m[2]));
      end = stat.size - 1;
    }
    if (start >= stat.size || end < start) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } });
    }
    end = Math.min(end, stat.size - 1);
    const s = st.createReadStream(a.key, { start, end })!;
    return new Response(Readable.toWeb(s as Readable) as ReadableStream, {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": String(end - start + 1) },
    });
  }
  const s = st.createReadStream(a.key)!;
  return new Response(Readable.toWeb(s as Readable) as ReadableStream, {
    status: 200,
    headers: { ...headers, "Content-Length": String(stat.size) },
  });
});

export const HEAD = GET;
