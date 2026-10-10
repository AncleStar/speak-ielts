import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
vi.mock("../../scripts/_env", () => ({ loadDotEnv: vi.fn() }));
import { ensureLocalEnv } from "../../scripts/local-env";
import { loadDotEnv } from "../../scripts/_env";
const base = path.resolve("data/verification"), root = path.join(base, `local-env-${randomUUID()}`);
afterAll(async () => { if (!root.startsWith(base + path.sep)) throw new Error("Invalid cleanup path"); await fs.rm(root, { recursive: true, force: true }); });
it("first-use voice or startup commands create independent random credentials without overwriting later edits", async () => {
  const template = "DATABASE_URL=postgres://postgres:postgres@localhost:5433/interview\nBETTER_AUTH_SECRET=\nADMIN_INITIAL_PASSWORD=\nAI_PROVIDER=mock\n";
  for (const name of ["first", "second"]) {
    await fs.mkdir(path.join(root, name), { recursive: true }); await fs.writeFile(path.join(root, name, ".env.example"), template);
    expect(ensureLocalEnv(path.join(root, name))).toBe(true);
  }
  const first = await fs.readFile(path.join(root, "first", ".env"), "utf8"), second = await fs.readFile(path.join(root, "second", ".env"), "utf8");
  expect(first).toMatch(/^BETTER_AUTH_SECRET=[a-f0-9]{64}$/m); expect(first).toMatch(/^ADMIN_INITIAL_PASSWORD=[A-Za-z0-9_-]{24}$/m);
  expect(first).not.toBe(second); expect(first).toContain("AI_PROVIDER=mock");
  expect(ensureLocalEnv(path.join(root, "first"))).toBe(false); expect(await fs.readFile(path.join(root, "first", ".env"), "utf8")).toBe(first);
  expect(loadDotEnv).toHaveBeenCalledWith(path.join(root, "first", ".env"));
});
it("existing configuration is preserved even when its original template is absent", async () => {
  const folder = path.join(root, "existing"), content = "# User-owned configuration\nAI_PROVIDER=mock\n";
  await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, ".env"), content);
  expect(ensureLocalEnv(folder)).toBe(false); expect(await fs.readFile(path.join(folder, ".env"), "utf8")).toBe(content);
  expect(loadDotEnv).toHaveBeenCalledWith(path.join(folder, ".env"));
});
