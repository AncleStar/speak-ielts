import "./_env";
import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/env";
import { naturalTts, naturalVoiceIdentity, prepareNaturalVoice, disposeNaturalVoice } from "@/lib/providers/natural-tts";
import { ensureLocalEnv } from "./local-env";
import { VoiceCacheError, type VoiceProgress } from "@/lib/providers/natural-voice-cache";

const cancellation = new AbortController();
const cancel = () => cancellation.abort();
process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
let lastProgress = 0;
function progress(event: VoiceProgress) {
  if (event.stage === "download" && Date.now() - lastProgress < 1000 && event.loaded > 0 && event.loaded < event.total) return;
  lastProgress = Date.now();
  if (event.stage === "download") console.log(`下载 ${event.file}：${(event.loaded / 1024 / 1024).toFixed(1)} / ${(event.total / 1024 / 1024).toFixed(1)} MB · ${Math.floor(event.loaded / event.total * 100)}%`);
  else if (event.stage === "cached") console.log(`已校验缓存：${event.file}`);
  else if (event.stage === "verified") console.log(`下载与校验完成：${event.file}`);
  else if (event.stage === "retry") console.log(`网络请求失败，重试 ${event.file}（第 ${event.attempt} 次）`);
}

try {
  if (ensureLocalEnv()) console.log("已创建本机 .env，初始账号与密码请在文件中查看。");
  console.log("准备自然语音模型，首次需下载约 93 MB；后续使用本机缓存。");
  console.log("下载总等待上限 20 分钟；连接超过 30 秒或传输停滞超过 45 秒会终止请求，最多重试一次。Ctrl+C 取消准备。");
  await prepareNaturalVoice(true, { signal: cancellation.signal, onProgress: progress });
  cancellation.signal.throwIfAborted();
  console.log("模型已校验，正在生成试听…");
  const sample = await naturalTts("Good morning. My name is Emma. Let's start with a few questions about you. Do you work, or are you a student?");
  // Native inference may finish after cancellation; never publish its sample as successful preparation.
  cancellation.signal.throwIfAborted();
  const destination = path.join(dataDir(), "voice-preview", "examiner.wav");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, sample.audio);
  console.log(JSON.stringify({ ...naturalVoiceIdentity(), sample: destination, latencyMs: sample.latencyMs }));
} catch (error) {
  console.error(error instanceof VoiceCacheError ? error.message : cancellation.signal.aborted ? "自然语音准备已取消；完整缓存保留，可稍后重试。" : "自然语音准备失败，请检查网络、缓存、磁盘空间和配置后重试。");
  process.exitCode = 1;
} finally {
  await disposeNaturalVoice();
  process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
}
