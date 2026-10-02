import { afterEach, describe, expect, it, vi } from "vitest";
import { wordErrorRate } from "@/lib/evaluation/asr";
import { createDashscopeProviders } from "@/lib/providers/dashscope";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("ASR metrics and provider contract (stubbed network)", () => {
  it("counts substitutions, insertions and deletions without calling them ability scores", () => {
    expect(wordErrorRate("I like tea", "I really like coffee")?.errors).toBe(2);
    expect(wordErrorRate("Hello, WORLD!", "hello world")?.rate).toBe(0);
    expect(wordErrorRate("", "hallucinated words")).toBeNull();
  });
  it("sends actual audio only, preserves hesitations and never sends the reference answer", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "local-test-placeholder");
    vi.stubEnv("DATABASE_URL", "postgres://unused:unused@localhost:5547/unused");
    const { resetEnvCache } = await import("@/lib/env"); resetEnvCache();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "Well, I, I think it is useful." } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await createDashscopeProviders().asr({ audio: Buffer.from("sample audio"), mime: "audio/wav", durationSec: 8, mockHint: { referenceText: "DO_NOT_SEND_REFERENCE", speechSec: 8 } });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]; const body = JSON.parse(String(call[1].body));
    expect(body.asr_options).toEqual({ language: "en", enable_itn: false }); expect(JSON.stringify(body)).not.toContain("DO_NOT_SEND_REFERENCE");
    expect(result.mock).toBe(false); expect(result.text).toContain("I, I");
  });
});
