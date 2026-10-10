import { afterEach, expect, it, vi } from "vitest";
import { activateLocalAccount, discardStoppedRecording, endLocalAccount, getMeta, listRecordings, putChunk, recordingRecoveryState, recoverRecording, saveMeta, syncLocalRecordingConsent, type RecordingMeta } from "@/lib/client/idb";
import { holdRecording, RECORDING_GUARD } from "@/lib/client/recording-owner";
import { uploadQueue } from "@/lib/client/uploader";

function browserLocks() {
  const occupied = new Set<string>();
  vi.stubGlobal("navigator", { locks: { request: async (name: string, _: unknown, callback: (lock: object | null) => unknown) => {
    if (occupied.has(name)) return callback(null);
    occupied.add(name); try { return await callback({ name }); } finally { occupied.delete(name); }
  } } });
}
async function setup(empty = false) {
  const scope = await activateLocalAccount("recovery-unit", undefined, { allowed: true, version: 1 });
  const meta: RecordingMeta = { id: crypto.randomUUID(), userId: scope.userId!, localEpoch: scope.epoch, consentVersion: 1, sessionId: "synthetic", planIndex: 0, kind: "main", followUpId: null, promptText: "Synthetic lock check", mimeType: "audio/webm", createdAt: Date.now(), durationMs: 3000, status: "recording", interrupted: false, recordingGuard: RECORDING_GUARD };
  await saveMeta(meta); if (!empty) await putChunk(meta.id, 0, new Blob(["synthetic-only"]));
  return { scope, meta };
}
afterEach(async () => { await endLocalAccount(null); vi.unstubAllGlobals(); });
it("a held browser lock prevents recovery, deletion and premature upload even when the timestamp is old", async () => {
  browserLocks(); const { meta } = await setup(), ownership = await holdRecording(meta.id);
  try {
    expect(await recordingRecoveryState({ ...meta, createdAt: Date.now() - 11 * 60000 })).toBe("live");
    await expect(recoverRecording(meta.id)).rejects.toThrow("仍在录音"); await expect(discardStoppedRecording(meta.id)).rejects.toThrow("仍在录音");
    await expect(uploadQueue.enqueue(meta)).rejects.toThrow("尚未结束"); expect((await getMeta(meta.id))?.interrupted).toBe(false);
  } finally { ownership.release(); }
});
it("two pages can finalize an orphan only once and it is always interrupted", async () => {
  browserLocks(); const { meta } = await setup();
  const results = await Promise.allSettled([recoverRecording(meta.id), recoverRecording(meta.id)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(await getMeta(meta.id)).toMatchObject({ status: "pending", interrupted: true, durationMs: 3000 });
});
it("no durable chunks means no invented recording; the stopped empty entry can be discarded", async () => {
  browserLocks(); const { meta } = await setup(true); await expect(recoverRecording(meta.id)).rejects.toThrow("没有已写入");
  expect((await getMeta(meta.id))?.status).toBe("recording"); await discardStoppedRecording(meta.id); expect(await listRecordings()).toEqual([]);
});
it("withdrawal and reconsent cannot revive a previously retained orphan", async () => {
  browserLocks(); const { scope, meta } = await setup(); await syncLocalRecordingConsent(scope.userId!, { allowed: false, version: 2 });
  await syncLocalRecordingConsent(scope.userId!, { allowed: true, version: 3 }); await expect(recoverRecording(meta.id)).rejects.toThrow("状态已改变");
  expect(await listRecordings()).toEqual([]); await expect(saveMeta(meta)).rejects.toThrow("录音授权");
});
it("missing lock support and legacy metadata do not guess ownership from elapsed time", async () => {
  const { meta } = await setup(); vi.stubGlobal("navigator", {});
  expect(await recordingRecoveryState(meta)).toBe("unverified"); await expect(recoverRecording(meta.id)).rejects.toThrow("仍在录音");
  browserLocks(); expect(await recordingRecoveryState({ ...meta, recordingGuard: undefined })).toBe("unverified");
});
it("logout clears the orphan and an old recover or write cannot affect a new login", async () => {
  browserLocks(); const { scope, meta } = await setup(); await endLocalAccount(scope); await activateLocalAccount("recovery-other", undefined, { allowed: true, version: 1 });
  await expect(recoverRecording(meta.id)).rejects.toThrow("状态已改变"); await expect(saveMeta(meta)).rejects.toThrow("登录已结束"); expect(await listRecordings()).toEqual([]);
});
