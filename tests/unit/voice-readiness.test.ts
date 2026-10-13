import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ kind: "local", label: "Synthetic voice", check: vi.fn(), auth: vi.fn() }));
vi.mock("@/lib/env", () => ({ dataDir: () => "data/verification/synthetic-voice-status" }));
vi.mock("@/lib/providers", () => ({ providers: () => ({ ttsKind: state.kind, ttsIdentity: () => ({ label: state.label, voice: "synthetic" }) }) }));
vi.mock("@/lib/providers/natural-voice-cache", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/providers/natural-voice-cache")>(), ensureNaturalVoiceCache: state.check }));
vi.mock("@/lib/auth-server", () => ({ apiUser: state.auth, handle: (fn: unknown) => fn, json: (data: unknown) => Response.json(data, { headers: { "Cache-Control": "no-store" } }) }));
import { checkVoiceReadiness } from "@/lib/services/voice-readiness";
import { NATURAL_FILES, VoiceCacheError } from "@/lib/providers/natural-voice-cache";
import { GET } from "@/app/api/admin/voice-status/route";
beforeEach(() => { state.kind = "local"; state.label = "Synthetic voice"; state.check.mockReset(); state.auth.mockReset().mockResolvedValue({ isAdmin: true }); });
it("does not dispatch local or cloud inference when model verification is not applicable", async () => {
  for (const kind of ["mock", "cloud"]) { state.kind = kind; expect(await checkVoiceReadiness()).toMatchObject({ state: "not_required", provider: kind, checkedFiles: 0, totalFiles: 0 }); }
  expect(state.check).not.toHaveBeenCalled();
});
it("only marks model files verified after every pinned file passed a read-only bounded check", async () => {
  state.check.mockImplementation(async (_root, options) => { expect(options.allowDownload).toBeUndefined(); expect(options.timeoutMs).toBe(10000); for (const file of NATURAL_FILES) options.onProgress({ stage: "cached", file: file.file }); });
  expect(await checkVoiceReadiness()).toMatchObject({ state: "ready", checkedFiles: 4, totalFiles: 4 });
});
it("distinguishes missing cache from unavailable storage and does not expose private paths or raw failures", async () => {
  for (const [error, expected] of [[new VoiceCacheError("missing", "private-path-and-secret"), "unprepared"], [new VoiceCacheError("timeout", "private-path-and-secret"), "unavailable"], [new Error("private-path-and-secret"), "unavailable"]] as const) {
    state.check.mockRejectedValueOnce(error); const response = await checkVoiceReadiness(); expect(response.state).toBe(expected); expect(JSON.stringify(response)).not.toContain("private-path-and-secret");
  }
});
it("requires admin access before touching files and rechecks after the asynchronous read", async () => {
  state.auth.mockRejectedValueOnce(new Error("not-admin")); await expect(GET()).rejects.toThrow("not-admin"); expect(state.check).not.toHaveBeenCalled();
  state.check.mockResolvedValue(undefined); const result = await GET(); expect(state.auth).toHaveBeenLastCalledWith({ admin: true }); expect(state.auth).toHaveBeenCalledTimes(3); expect(result.headers.get("Cache-Control")).toBe("no-store");
  state.auth.mockResolvedValueOnce({ isAdmin: true }).mockRejectedValueOnce(new Error("admin-revoked")); await expect(GET()).rejects.toThrow("admin-revoked");
});
