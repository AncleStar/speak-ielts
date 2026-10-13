import { afterEach, expect, it } from "vitest";
import { env, resetEnvCache } from "@/lib/env";
import { evaluateWorkerHealth, runtimeConfigId, WORKER_FUTURE_TOLERANCE_MS, WORKER_STALE_MS } from "@/lib/worker-runtime";
const before = { ...process.env };
afterEach(() => { process.env = { ...before }; resetEnvCache(); });
function config() { Object.assign(process.env, { DATABASE_URL: "postgres://unused", BETTER_AUTH_SECRET: "worker-synthetic-auth-secret-000000000", AI_PROVIDER: "dashscope", TTS_PROVIDER: "kokoro", USER_API_KEY_SECRET: "worker-synthetic-encryption-secret-000", DASHSCOPE_API_KEY: "synthetic-site-key", STORAGE_DRIVER: "local", DATA_DIR: "data/verification/synthetic", LOCAL_STORAGE_DIR: "data/verification/synthetic/storage", LOCAL_TTS_SPEED: "0.95" }); resetEnvCache(); return env(); }
it("changes compatibility for voice speed, storage, endpoints, diagnosis, encryption and visible builds without exposing them", () => {
  const e = config(), original = runtimeConfigId(e, "first-build");
  for (const patch of [{ LOCAL_TTS_SPEED: 0.85 }, { LOCAL_STORAGE_DIR: "data/verification/other" }, { DATA_DIR: "data/verification/other" }, { DASHSCOPE_BASE_URL: "https://different.example.test/v1" }, { USER_API_KEY_SECRET: "other-encryption-secret-synthetic-0000" }, { DASHSCOPE_API_KEY: "other-synthetic-site-key" }, { TIME_SCALE: 0.08 }, { ENABLE_AUDIO_DIAGNOSIS: true }, { FFMPEG_PATH: "other-ffmpeg" }]) expect(runtimeConfigId({ ...e, ...patch }, "first-build")).not.toBe(original);
  expect(runtimeConfigId(e, "second-build")).not.toBe(original); expect(original).toMatch(/^v2_[a-f0-9]{32}$/); expect(original).not.toContain(e.DASHSCOPE_API_KEY); expect(original).not.toContain(e.USER_API_KEY_SECRET);
});
it("normalizes equivalent local directories and does not treat unused cloud keys as model compatibility", () => {
  const e = { ...config(), AI_PROVIDER: "mock" as const, TTS_PROVIDER: "mock" as const };
  expect(runtimeConfigId(e, "same")).toBe(runtimeConfigId({ ...e, DATA_DIR: e.DATA_DIR + "/../synthetic", DASHSCOPE_API_KEY: "unused-other-key" }, "same"));
});
it("rejects future, expired, mismatched and mixed heartbeat evidence while accepting compatible idle workers", () => {
  const now = new Date(), id = "synthetic-compatible", good = { value: { configId: id }, at: now }, wrong = { value: { configId: "other" }, at: now };
  expect(evaluateWorkerHealth([], id, now)).toMatchObject({ ready: false, state: "missing" });
  expect(evaluateWorkerHealth([good], id, now)).toMatchObject({ ready: true, state: "ready" });
  expect(evaluateWorkerHealth([wrong], id, now)).toMatchObject({ ready: false, state: "mismatch" });
  expect(evaluateWorkerHealth([good, wrong], id, now)).toMatchObject({ ready: false, state: "mixed" });
  expect(evaluateWorkerHealth([{ ...good, at: new Date(+now - WORKER_STALE_MS) }], id, now)).toMatchObject({ ready: false, state: "stale" });
  const future = { ...good, at: new Date(+now + WORKER_FUTURE_TOLERANCE_MS + 1) };
  expect(evaluateWorkerHealth([future, good], id, now)).toMatchObject({ ready: false, state: "clock" });
  expect(evaluateWorkerHealth([{ ...good, at: new Date(NaN) }], id, now).ready).toBe(false);
});
