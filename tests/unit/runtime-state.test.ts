import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { writeRuntimeState } from "../../scripts/runtime-state";
const base = path.resolve("data/verification"), root = path.join(base, `runtime-state-${randomUUID()}`), file = path.join(root, "state.json");
fs.mkdirSync(root, { recursive: true });
afterEach(() => vi.restoreAllMocks());
afterAll(() => { if (!root.startsWith(base + path.sep)) throw new Error("Invalid cleanup path"); fs.rmSync(root, { recursive: true, force: true }); });
it("retries transient Windows read locks while retaining the complete previous state", () => {
  writeRuntimeState(file, { status: "starting" }); const rename = fs.renameSync; let attempts = 0;
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    attempts++;
    if (attempts <= 2) { expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ status: "starting" }); throw Object.assign(new Error("Synthetic read lock"), { code: "EPERM" }); }
    return rename(from, to);
  });
  writeRuntimeState(file, { status: "ready" }); expect(attempts).toBe(3);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ status: "ready" }); expect(fs.existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
});
it("persistent locks and unrelated errors stop after bounded retries without corrupting the previous state", () => {
  writeRuntimeState(file, { status: "ready" });
  const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw Object.assign(new Error("Persistent read lock"), { code: "EBUSY" }); });
  expect(() => writeRuntimeState(file, { status: "stopped" })).toThrow("Persistent read lock"); expect(rename).toHaveBeenCalledTimes(6); expect(fs.existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  rename.mockReset().mockImplementation(() => { throw Object.assign(new Error("Missing destination"), { code: "ENOENT" }); });
  expect(() => writeRuntimeState(file, { status: "stopped" })).toThrow("Missing destination"); expect(rename).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ status: "ready" });
});
