import "./_env";
import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/env";
import { naturalTts, naturalVoiceIdentity, prepareNaturalVoice, disposeNaturalVoice } from "@/lib/providers/natural-tts";

try {
  console.log("准备自然语音模型，首次需下载约 93 MB；后续使用本机缓存。");
  await prepareNaturalVoice(true);
  const sample = await naturalTts("Good morning. My name is Emma. Let's start with a few questions about you. Do you work, or are you a student?");
  const destination = path.join(dataDir(), "voice-preview", "examiner.wav");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, sample.audio);
  console.log(JSON.stringify({ ...naturalVoiceIdentity(), sample: destination, latencyMs: sample.latencyMs }));
} finally {
  await disposeNaturalVoice();
}
