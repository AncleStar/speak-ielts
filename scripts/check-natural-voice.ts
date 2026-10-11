import "./_env";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir, resetEnvCache } from "@/lib/env";
import { disposeNaturalVoice, naturalTts, speechChunks } from "@/lib/providers/natural-tts";
import { NATURAL_MODEL_TAG } from "@/lib/providers/natural-voice-cache";

/** Decode the actual WAV container rather than assuming a fixed header size. */
function inspectWav(bytes: Buffer) {
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
  let format = 0, channels = 0, rate = 0, bits = 0;
  let samples: Buffer | undefined;
  for (let cursor = 12; cursor + 8 <= bytes.length;) {
    const kind = bytes.toString("ascii", cursor, cursor + 4), size = bytes.readUInt32LE(cursor + 4);
    const start = cursor + 8;
    assert.ok(start + size <= bytes.length, "WAV chunk is truncated");
    if (kind === "fmt ") {
      assert.ok(size >= 16);
      format = bytes.readUInt16LE(start); channels = bytes.readUInt16LE(start + 2);
      rate = bytes.readUInt32LE(start + 4); bits = bytes.readUInt16LE(start + 14);
    } else if (kind === "data") samples = bytes.subarray(start, start + size);
    cursor = start + size + (size % 2);
  }
  assert.equal(channels, 1); assert.equal(rate, 24000);
  assert.ok(samples && samples.length > 0);
  assert.ok(format === 1 && bits === 16 || format === 3 && bits === 32, "Unsupported WAV encoding");
  const stride = bits / 8;
  assert.equal(samples.length % stride, 0);
  const count = samples.length / stride;
  let energy = 0, peak = 0;
  for (let offset = 0; offset < samples.length; offset += stride) {
    const value = format === 1 ? samples.readInt16LE(offset) / 32768 : samples.readFloatLE(offset);
    assert.ok(Number.isFinite(value)); energy += value * value; peak = Math.max(peak, Math.abs(value));
  }
  const seconds = count / rate, rms = Math.sqrt(energy / count);
  assert.ok(seconds > 1 && seconds < 90 && peak > 0.01 && rms > 0.001, "Audio is empty, silent, or outside the fixture duration bound");
  return { sampleRate: rate, channels, seconds, peak, rms };
}

const originalVoice = process.env.LOCAL_TTS_VOICE, originalSpeed = process.env.LOCAL_TTS_SPEED;
const originalFetch = globalThis.fetch;
let downloadAttempts = 0;
const directory = path.join(dataDir(), "verification", `natural-voice-${Date.now()}-${randomUUID().slice(0, 8)}`);
try {
  // This diagnostic calls the local provider directly. It never uses cloud TTS or the worker queue.
  globalThis.fetch = async () => { downloadAttempts++; throw new Error("Offline voice verification forbids HTTP fetch"); };
  await fs.mkdir(directory, { recursive: true });
  const cases = [
    { voice: "bf_emma", speed: 0.95, text: "Good morning. Do you work, or are you a student?" },
    { voice: "bf_isabella", speed: 0.8, text: "Tell me about a hobby you enjoy." },
    { voice: "bm_george", speed: 1.2, text: "What do you like about your hometown?" },
    { voice: "af_heart", speed: 0.95, text: "Why is it important to learn new skills?" },
    { voice: "bf_emma", speed: 0.95, text: "I believe that university students should take part in practical activities. These experiences help them develop confidence and understand how their studies relate to everyday life. They also provide opportunities to meet people from different backgrounds and learn how to work together. For example, volunteering at a community centre can improve communication skills and encourage students to think about the needs of others. In the long term, this experience can help them make better decisions about their future careers." },
  ];
  const results = [];
  for (const [index, fixture] of cases.entries()) {
    process.env.LOCAL_TTS_VOICE = fixture.voice; process.env.LOCAL_TTS_SPEED = String(fixture.speed); resetEnvCache();
    const chunks = speechChunks(fixture.text);
    if (index === cases.length - 1) assert.ok(chunks.length > 1, "Long-answer fixture must exercise actual multi-chunk synthesis");
    const audio = await naturalTts(fixture.text);
    assert.equal(audio.mock, false); assert.equal(audio.model, NATURAL_MODEL_TAG);
    assert.equal(audio.voice, `${fixture.voice}@${fixture.speed.toFixed(2)}-v1`); assert.equal(audio.mime, "audio/wav");
    assert.equal(audio.chars, fixture.text.length);
    const metadata = inspectWav(audio.audio);
    const filename = `${index}-${fixture.voice}.wav`;
    await fs.writeFile(path.join(directory, filename), audio.audio, { mode: 0o600 });
    results.push({ voice: fixture.voice, speed: fixture.speed, chunks: chunks.length, filename, latencyMs: audio.latencyMs, ...metadata });
  }
  await assert.rejects(naturalTts("   "), /不能为空/);
  await assert.rejects(naturalTts("x".repeat(281)), /过长/);
  assert.equal(downloadAttempts, 0);
  const report = { passed: true, checkedAt: new Date().toISOString(), node: process.version, model: NATURAL_MODEL_TAG, httpFetchAttempts: downloadAttempts, actualLocalSynthesis: true, inputErrorsRejected: true, results };
  await fs.writeFile(path.join(directory, "acceptance.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`自然语音离线检查通过：四种音色、速度边界、长回答分段及无效输入。证据：${directory}`);
  console.log("未调用付费服务。音频合成检查不代替人工听感、口音或教学质量验收。");
} catch (error) {
  console.error("自然语音离线检查失败：", error instanceof Error ? error.message : "未知错误");
  console.error("请检查依赖与缓存，先运行 npm run setup:voice 准备模型；诊断不会自动下载或切换到云服务。");
  process.exitCode = 1;
} finally {
  await disposeNaturalVoice().catch(() => { process.exitCode = 1; });
  globalThis.fetch = originalFetch;
  if (originalVoice === undefined) delete process.env.LOCAL_TTS_VOICE; else process.env.LOCAL_TTS_VOICE = originalVoice;
  if (originalSpeed === undefined) delete process.env.LOCAL_TTS_SPEED; else process.env.LOCAL_TTS_SPEED = originalSpeed;
  resetEnvCache();
}
