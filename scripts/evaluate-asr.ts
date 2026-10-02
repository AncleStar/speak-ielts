import "./_env";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
if (!process.argv.includes("--real")) throw new Error("请加 --real 明确启用真实服务；所有调用计入后台现有预算。");
process.env.AI_PROVIDER = "dashscope";
const { env, dataDir } = await import("@/lib/env");
if (!env().DASHSCOPE_API_KEY) throw new Error("请在本机 .env 配置 DASHSCOPE_API_KEY，不要在聊天中提供密钥。");
const { metered } = await import("@/lib/providers/metered");
const { makeTempDir, transcodeToWav, analyzeWav, ASR_MAX_BASE64_BYTES } = await import("@/lib/audio");
const { wordErrorRate } = await import("@/lib/evaluation/asr");
const manifestArg = process.argv[process.argv.indexOf("--manifest") + 1];
if (!process.argv.includes("--manifest") || !manifestArg) throw new Error("请指定 --manifest 真实录音样本清单.json");
const manifestPath = path.resolve(manifestArg);
const schema = z.array(z.object({ id: z.string().min(1).max(80), file: z.string(), reference: z.string().max(5000), category: z.enum(["clear", "chinese_accent", "noise", "pauses", "silence"]) })).min(1).max(30);
const samples = schema.parse(JSON.parse(await fs.readFile(manifestPath, "utf8")));
const results: object[] = [], stamp = Date.now();
try {
  for (const sample of samples) {
    const dir = await makeTempDir("ia-asr-eval-");
    try {
      const audioPath = path.resolve(path.dirname(manifestPath), sample.file), wav = path.join(dir, "audio.wav");
      await transcodeToWav(audioPath, wav); const metrics = await analyzeWav(wav);
      if (metrics.speechSec < 3) { results.push({ id: sample.id, category: sample.category, status: "insufficient_audio", expectedSilence: sample.category === "silence", metrics }); continue; }
      const audio = await fs.readFile(wav);
      if (metrics.durationSec > 300 || Math.ceil(audio.length / 3) * 4 > ASR_MAX_BASE64_BYTES) throw new Error("sample_too_large");
      const result = await metered(`asr-eval:${stamp}:${sample.id}`).asr({ audio, mime: "audio/wav", durationSec: metrics.durationSec });
      results.push({ id: sample.id, category: sample.category, status: "recognized", text: result.text, reference: sample.reference, wer: wordErrorRate(sample.reference, result.text), latencyMs: result.latencyMs, model: result.model });
      console.log(`已处理 ${sample.id}（结果仅保存在本机报告）`);
    } catch { results.push({ id: sample.id, category: sample.category, status: "failed", note: "检查文件、网络、服务权限与现有预算；未自动增加预算" }); }
    finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
  await fs.mkdir(dataDir(), { recursive: true });
  const output = path.join(dataDir(), `asr-evaluation-${stamp}.json`);
  await fs.writeFile(output, JSON.stringify({ at: new Date().toISOString(), qualityValidated: false, note: "WER仅反映本批样本转写差异；仍需人工核对含义、噪声表现与反馈。", results }, null, 2));
  console.log(`结果：${output}`);
} finally { await (await import("@/lib/db")).closeDb(); }
