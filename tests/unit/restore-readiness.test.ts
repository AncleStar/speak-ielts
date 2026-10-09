import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { env, resetEnvCache } from "@/lib/env";
afterEach(() => { vi.unstubAllEnvs(); resetEnvCache(); });
it("blocks cached application configuration until restoration is finalized", async () => {
  const root = path.resolve(`data/verification/restore-readiness-${crypto.randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  vi.stubEnv("DATABASE_URL", "postgres://postgres:postgres@127.0.0.1:5552/test_only"); vi.stubEnv("DATA_DIR", root); vi.stubEnv("RESTORE_FINALIZE", "false");
  resetEnvCache(); expect(env().DATA_DIR).toBe(root);
  const marker = path.join(root, "restore-pending.json"); await fs.writeFile(marker, "{}");
  expect(() => env()).toThrow(expect.objectContaining({ status: 503, code: "restore_incomplete" }));
  vi.stubEnv("RESTORE_FINALIZE", "true"); expect(env().DATA_DIR).toBe(root);
  vi.stubEnv("RESTORE_FINALIZE", "false"); await fs.rm(marker); expect(env().DATA_DIR).toBe(root);
});
