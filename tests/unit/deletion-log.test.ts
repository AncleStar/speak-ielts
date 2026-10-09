import { describe, expect, it } from "vitest";
import { mergeDeletionLogs, parseDeletionLog } from "@/lib/deletion-log";
const entry = { id: "test-intent", kind: "thought", targetId: "test-thought", userId: "test-owner", at: "2026-10-09T00:00:00Z" };
describe("restore deletion journal", () => {
  it("merges current and archived journals without losing later intents", () => {
    const line = JSON.stringify(entry) + "\n", later = { ...entry, id: "later", kind: "vocabulary", targetId: "test-word" };
    expect(parseDeletionLog(mergeDeletionLogs(line, line + JSON.stringify(later) + "\n"))).toEqual([entry, later]);
  });
  it("refuses damaged, unsupported and conflicting entries", () => {
    expect(() => parseDeletionLog("broken\n")).toThrow("损坏");
    expect(() => parseDeletionLog(JSON.stringify({ ...entry, kind: "unknown" }))).toThrow("损坏");
    expect(() => parseDeletionLog(JSON.stringify({ ...entry, targetId: null }))).toThrow("损坏");
    expect(() => mergeDeletionLogs(JSON.stringify(entry), JSON.stringify({ ...entry, targetId: "another" }))).toThrow("冲突");
  });
  it("continues to read existing session and account deletion records", () => {
    expect(parseDeletionLog(JSON.stringify({ ...entry, kind: "session" }))[0].kind).toBe("session");
    expect(parseDeletionLog(JSON.stringify({ ...entry, kind: "user", userId: null }))[0].kind).toBe("user");
  });
});
