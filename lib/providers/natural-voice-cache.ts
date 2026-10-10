import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

export const NATURAL_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const NATURAL_REVISION = "1939ad2a8e416c0acfeecc08a694d14ef25f2231";
export const NATURAL_MODEL_TAG = "kokoro-82m-v1-q8-1939ad2";
// Immutable upstream revision: model SHA-256 is the upstream LFS object; JSON hashes also verified against Git objects.
export const NATURAL_FILES = [
  { file: "config.json", bytes: 44, sha256: "df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f" },
  { file: "tokenizer_config.json", bytes: 113, sha256: "be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20" },
  { file: "tokenizer.json", bytes: 3497, sha256: "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34" },
  { file: "onnx/model_quantized.onnx", bytes: 92361116, sha256: "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478" },
] as const;
export type VoiceFile = { file: string; bytes: number; sha256: string };
export type VoiceProgress = { stage: "checking" | "cached" | "download" | "retry" | "verified"; file: string; loaded: number; total: number; attempt?: number };
export class VoiceCacheError extends Error {
  constructor(public readonly code: "missing" | "invalid" | "unsafe" | "timeout" | "cancelled" | "network" | "integrity" | "storage", message: string) { super(message); this.name = "VoiceCacheError"; }
}
export const voiceCacheDirectory = (cacheRoot: string) => path.resolve(cacheRoot, NATURAL_MODEL_ID, NATURAL_REVISION);
async function checkDirectories(root: string, file: string, create: boolean) {
  const relative = path.relative(root, path.dirname(file));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new VoiceCacheError("unsafe", "模型缓存路径无效。");
  for (const directory of [root, ...relative.split(path.sep).filter(Boolean).map((_, i, parts) => path.join(root, ...parts.slice(0, i + 1)))]) {
    let stat = await fs.lstat(/* turbopackIgnore: true */ directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!stat && create) { await fs.mkdir(/* turbopackIgnore: true */ directory, { recursive: true }); stat = await fs.lstat(/* turbopackIgnore: true */ directory); }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new VoiceCacheError("unsafe", "模型缓存目录不能使用符号链接或普通文件。");
  }
}
async function verified(file: string, entry: VoiceFile) {
  const stat = await fs.lstat(/* turbopackIgnore: true */ file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new VoiceCacheError("unsafe", "模型缓存必须是普通文件，不能使用符号链接。");
  if (stat.size !== entry.bytes) return false;
  const hash = createHash("sha256"); for await (const chunk of createReadStream(/* turbopackIgnore: true */ file)) hash.update(chunk as Buffer);
  return hash.digest("hex") === entry.sha256;
}

export interface VoiceCacheOptions {
  allowDownload?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: VoiceProgress) => void;
  /** Total deadline for all files and retries; it never resets between chunks. */
  timeoutMs?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
  /** Test fixtures may supply an isolated manifest and transport; runtime always uses the pinned upstream files. */
  files?: readonly VoiceFile[];
  fetchFile?: (file: string, signal: AbortSignal) => Promise<Response>;
}

/** Atomic, bounded model preparation. A failed/cancelled request never becomes a final cache entry. */
export async function ensureNaturalVoiceCache(cacheRoot: string, options: VoiceCacheOptions = {}) {
  const root = voiceCacheDirectory(cacheRoot), cacheBase = path.resolve(cacheRoot), controller = new AbortController();
  const timeout = options.timeoutMs ?? 20 * 60_000, idleTimeout = options.idleTimeoutMs ?? 45_000, connectTimeout = options.connectionTimeoutMs ?? 30_000;
  const abort = () => controller.abort(new VoiceCacheError("cancelled", "自然语音准备已取消；可重新运行命令，完整缓存会保留。"));
  options.signal?.addEventListener("abort", abort, { once: true }); if (options.signal?.aborted) abort();
  const deadline = setTimeout(() => controller.abort(new VoiceCacheError("timeout", "自然语音准备已超时；请检查网络后重试，完整缓存会保留。")), timeout);
  const emit = (stage: VoiceProgress["stage"], entry: VoiceFile, loaded = 0, attempt?: number) => options.onProgress?.({ stage, file: entry.file, loaded, total: entry.bytes, attempt });
  try {
    for (const entry of options.files ?? NATURAL_FILES) {
      if (!/^[a-zA-Z0-9_./-]+$/.test(entry.file) || entry.file.includes("..") || path.isAbsolute(entry.file)) throw new VoiceCacheError("unsafe", "模型文件路径无效。");
      controller.signal.throwIfAborted();
      const destination = path.join(root, entry.file);
      await checkDirectories(cacheBase, destination, false); emit("checking", entry);
      if (await verified(destination, entry)) { emit("cached", entry, entry.bytes); continue; }
      if (!options.allowDownload) throw new VoiceCacheError("missing", "本机自然语音模型缺失或校验失败，请部署者运行 npm run setup:voice；面试期间不会自动下载。");
      await checkDirectories(cacheBase, destination, true);
      for (let attempt = 1; attempt <= 2; attempt++) {
        controller.signal.throwIfAborted();
        const temporary = `${destination}.${randomUUID()}.part`, attemptController = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined, handle: Awaited<ReturnType<typeof fs.open>> | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        const signal = AbortSignal.any([controller.signal, attemptController.signal]);
        const resetTimer = (duration: number) => { clearTimeout(timer); timer = setTimeout(() => attemptController.abort(new VoiceCacheError("timeout", "自然语音下载连接或传输停滞，正在停止本次请求。")), duration); };
        try {
          // Another preparation process may already have published the same verified immutable file.
          if (await verified(destination, entry)) { emit("cached", entry, entry.bytes); break; }
          resetTimer(connectTimeout); emit("download", entry, 0, attempt);
          const response = await (options.fetchFile ?? ((file, requestSignal) => fetch(`https://huggingface.co/${NATURAL_MODEL_ID}/resolve/${NATURAL_REVISION}/${file}`, { signal: requestSignal })))(entry.file, signal);
          if (!response.ok || !response.body) throw new VoiceCacheError("network", "自然语音下载失败，请检查网络后重试。");
          const length = response.headers.get("content-length");
          const encoding = response.headers.get("content-encoding");
          if ((!encoding || encoding === "identity") && length !== null && Number(length) !== entry.bytes) throw new VoiceCacheError("integrity", "模型响应大小不符，未写入正式缓存。");
          handle = await fs.open(/* turbopackIgnore: true */ temporary, "wx", 0o600); reader = response.body.getReader();
          const hash = createHash("sha256"); let loaded = 0;
          while (true) {
            signal.throwIfAborted(); resetTimer(idleTimeout);
            const result = await reader.read(); if (result.done) break;
            loaded += result.value.byteLength;
            if (loaded > entry.bytes) throw new VoiceCacheError("integrity", "模型下载超过预期大小，未写入正式缓存。");
            hash.update(result.value); await handle.writeFile(result.value); emit("download", entry, loaded, attempt);
          }
          clearTimeout(timer); signal.throwIfAborted();
          if (loaded !== entry.bytes || hash.digest("hex") !== entry.sha256) throw new VoiceCacheError("integrity", "模型下载不完整或校验失败，未写入正式缓存。");
          await handle.sync(); await handle.close(); handle = undefined;
          controller.signal.throwIfAborted();
          if (!await verified(destination, entry)) {
            try { await fs.rename(/* turbopackIgnore: true */ temporary, /* turbopackIgnore: true */ destination); }
            catch (error) { if (!await verified(destination, entry)) throw error; }
          }
          emit("verified", entry, entry.bytes); break;
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          const failure = attemptController.signal.aborted ? attemptController.signal.reason : error;
          if (["ENOSPC", "EACCES", "EPERM", "EROFS", "EMFILE", "ENFILE"].includes((failure as NodeJS.ErrnoException)?.code ?? ""))
            throw new VoiceCacheError("storage", "模型缓存无法写入，请检查磁盘空间、目录权限或文件占用后重试；完整缓存会保留。");
          if (attempt === 2 || failure instanceof VoiceCacheError && ["integrity", "unsafe"].includes(failure.code))
            throw failure instanceof VoiceCacheError ? failure : new VoiceCacheError("network", "自然语音准备失败；请检查网络、磁盘空间与目录权限后重试。");
          emit("retry", entry, 0, attempt + 1);
        } finally {
          clearTimeout(timer); attemptController.abort();
          await reader?.cancel().catch(() => {}); await handle?.close().catch(() => {});
          // Only this attempt's UUID file is removed. Never recursively clear the model cache.
          await fs.rm(/* turbopackIgnore: true */ temporary, { force: true });
        }
      }
    }
  } finally { clearTimeout(deadline); options.signal?.removeEventListener("abort", abort); }
}
