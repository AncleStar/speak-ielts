import "./_env";
import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/env";
import { naturalTts, naturalVoiceIdentity, prepareNaturalVoice, disposeNaturalVoice } from "@/lib/providers/natural-tts";
import { ensureLocalEnv } from "./local-env";

try {
  if (ensureLocalEnv()) console.log("已创建本机 .env，初始账号与密码请在文件中查看。");
  console.log("准备自然语音模型，首次需下载约 93 MB；后续使用本机缓存。");
  await prepareNaturalVoice(true);
  const sample = await naturalTts("Good morning. My name is Emma. Let's start with a few questions about you. Do you work, or are you a student?");
  const destination = path.join(dataDir(), "voice-preview", "examiner.wav");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, sample.audio);
  console.log(JSON.stringify({ ...naturalVoiceIdentity(), sample: destination, latencyMs: sample.latencyMs }));
} catch (error) {
  console.error("自然语音准备失败，请检查网络和配置后重试。", error instanceof Error ? error.message : "未知错误");
  process.exitCode = 1;
} finally {
  await disposeNaturalVoice();
}
