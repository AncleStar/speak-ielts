import "./_env";
import fs from "node:fs/promises";
import path from "node:path";
if (process.argv.includes("--real")) process.env.AI_PROVIDER = "dashscope";
const { env, dataDir } = await import("@/lib/env");
const { providers } = await import("@/lib/providers");
const { metered } = await import("@/lib/providers/metered");
const { isFfmpegAvailable, makeTempDir, transcodeToWav, analyzeWav } = await import("@/lib/audio");
const e = env();
const report = { at: new Date().toISOString(), provider: e.AI_PROVIDER, connectivityVerified: false, qualityValidated: false, checks: [] as { name: string; ok: boolean; note: string }[] };
async function check(name: string, work: () => Promise<string>) {
  try { const note = await work(); report.checks.push({ name, ok: true, note }); }
  catch (error) {
    // Do not persist vendor error bodies: they can echo requests or credentials.
    report.checks.push({ name, ok: false, note: error instanceof Error && error.message === "missing_key" ? "未配置 DASHSCOPE_API_KEY" : "检查失败；请核对服务配置、网络、模型权限与额度" });
  }
}
await check("ffmpeg", async () => { if (!await isFfmpegAvailable()) throw new Error("missing_ffmpeg"); return "可用"; });
if (e.AI_PROVIDER === "dashscope" && !e.DASHSCOPE_API_KEY) {
  await check("credentials", async () => { throw new Error("missing_key"); });
} else {
  const p = providers();
  const calls = metered(`provider-check:${Date.now()}`);
  let audio: Buffer | undefined;
  let duration = 0;
  await check("tts", async () => {
    const result = await calls.tts("I enjoy learning English because it helps me communicate with people from different places.");
    if (result.audio.length < 44) throw new Error("empty_audio");
    const dir = await makeTempDir("ia-check-");
    try { const input = path.join(dir, "input.wav"), output = path.join(dir, "normalized.wav"); await fs.writeFile(input, result.audio); await transcodeToWav(input, output); audio = await fs.readFile(output); duration = (await analyzeWav(output)).durationSec; }
    finally { await fs.rm(dir, { recursive: true, force: true }); }
    return `${result.model}：已生成音频`;
  });
  await check("asr", async () => {
    if (!audio) throw new Error("no_fixture");
    const r = await calls.asr({ audio, mime: "audio/wav", durationSec: duration, mockHint: { speechSec: duration, referenceText: "I enjoy learning English because it helps me communicate with people from different places." } });
    if (r.text.trim().split(/\s+/).length < 3) throw new Error("empty_transcript");
    return `${r.model}：已返回转写（此检查不测量口音识别准确率）`;
  });
  await check("llm", async () => {
    const r = await calls.llmJson({ purpose: "check", system: "Return JSON only: an object with ok set to true.", user: "Return the JSON health check.", maxTokens: 40 });
    if (!(r.json && typeof r.json === "object" && "ok" in r.json && r.json.ok === true)) throw new Error("invalid_json");
    return `${r.model}：结构化输出可用`;
  });
  if (e.ENABLE_AUDIO_DIAGNOSIS && p.omniAudio && audio) await check("omni", async () => {
    const r = await calls.omniAudio({ audio: audio!, mime: "audio/wav", prompt: "Briefly describe the spoken language in this recording." });
    if (!r.text) throw new Error("empty_result");
    return `${r.model}：可调用；尚不代表发音评估通过校准`;
  });
}
report.connectivityVerified = report.provider === "dashscope" && report.checks.every((c) => c.ok);
await fs.mkdir(dataDir(), { recursive: true });
await fs.writeFile(path.join(dataDir(), "provider-check.json"), JSON.stringify(report, null, 2));
for (const c of report.checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.note}`);
console.log(report.provider === "mock" ? "模拟模式检查：不计为真实服务验收。" : "真实连通检查完成；仍需真机与内容质量验收。");
if (report.checks.some((c) => !c.ok)) process.exitCode = 1;
await (await import("@/lib/db")).closeDb();
