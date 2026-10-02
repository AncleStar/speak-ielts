import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { providers, setProvidersForTest } from "@/lib/providers";
import { speechChunks } from "@/lib/providers/natural-tts";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
  setProvidersForTest(null);
});

describe("natural examiner voice", () => {
  it("preserves every word in a long answer without exceeding a speech chunk", () => {
    const text = `Good morning. ${"Learning English helps me communicate with more people ".repeat(25)}Thank you.`;
    const chunks = speechChunks(text);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every(c => c.length <= 280)).toBe(true);
    expect(chunks.join(" ")).toBe(text.replace(/\s+/g, " ").trim());
  });
  it("uses real local speech independently from mock transcription and changes cache identity with speed", () => {
    Object.assign(process.env, { DATABASE_URL: "postgres://unused", AI_PROVIDER: "mock", TTS_PROVIDER: "kokoro", LOCAL_TTS_VOICE: "bf_emma", LOCAL_TTS_SPEED: "0.95" });
    resetEnvCache(); setProvidersForTest(null);
    const first = providers();
    expect(first.name).toBe("mock"); expect(first.ttsKind).toBe("local");
    const oldVoice = first.ttsIdentity().voice;
    process.env.LOCAL_TTS_SPEED = "1.05"; resetEnvCache(); setProvidersForTest(null);
    expect(providers().ttsIdentity().voice).not.toBe(oldVoice);
  });
});
