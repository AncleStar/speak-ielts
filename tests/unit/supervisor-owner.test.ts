import { afterEach, expect, it, vi } from "vitest";
import childProcess from "node:child_process";
import { supervisorLockAlive } from "../../scripts/supervisor-owner";
afterEach(() => { vi.restoreAllMocks(); });
it("rejects malformed lock metadata before constructing an OS command", () => {
  expect(() => supervisorLockAlive({ pid: 0, instance: "old" })).toThrow("格式无效"); expect(() => supervisorLockAlive({ pid: 100, instance: "old'; harmful" })).toThrow("格式无效");
});
it.runIf(process.platform === "win32")("uses actual Windows process identity even when kill(pid,0) reports EPERM for absence", () => {
  const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); });
  expect(supervisorLockAlive({ pid: 2147483647, instance: "synthetic-missing" })).toBe(false);
  expect(supervisorLockAlive({ pid: process.pid, instance: "synthetic-other-process" })).toBe(false); expect(kill).not.toHaveBeenCalled();
});
it.runIf(process.platform === "win32")("preserves an owned process and refuses to replace an unidentifiable process lock", () => {
  const query = vi.spyOn(childProcess, "execFileSync").mockReturnValue("owned\r\n" as never);
  expect(supervisorLockAlive({ pid: process.pid, instance: "synthetic-owned" })).toBe(true);
  query.mockReturnValueOnce("unknown" as never); expect(() => supervisorLockAlive({ pid: process.pid, instance: "synthetic-owned" })).toThrow("未替换");
});
