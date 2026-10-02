import "./_env";
import { closeDb } from "@/lib/db";
import { loadContent } from "@/lib/content/load";
import { ensureTtsAssets, generateTtsAsset, questionTexts } from "@/lib/services/tts";
import { disposeNaturalVoice } from "@/lib/providers/natural-tts";

try {
  const content = loadContent();
  const questions = process.argv.includes("--all") ? content.questions : content.questions.slice(0, 4);
  const texts = [content.phrases.device_check, ...Object.values(content.phrases), ...questions.flatMap(questionTexts)];
  const ids = await ensureTtsAssets(texts, { enqueueMissing: false });
  let done = 0;
  for (const id of ids.values()) {
    await generateTtsAsset(id);
    console.log(`声音准备 ${++done}/${ids.size}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message.slice(0, 500) : "声音准备失败");
  process.exitCode = 1;
} finally {
  await closeDb();
  await disposeNaturalVoice();
}
