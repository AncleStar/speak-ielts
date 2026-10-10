import { afterEach, expect, it, vi } from "vitest";
import { activateLocalAccount, deletePendingUploadDiscard, endLocalAccount, getBlob, getMeta, listPendingUploadDiscards, localIdentity, putChunk, saveMeta, stageRecordingDiscard, syncLocalRecordingConsent, type PendingUploadDiscard, type RecordingMeta } from "@/lib/client/idb";
import { holdRecording, RECORDING_GUARD } from "@/lib/client/recording-owner";
async function setup(status: RecordingMeta["status"] = "pending") {
  const scope = await activateLocalAccount("discard-unit", undefined, { allowed: true, version: 1 }), id = crypto.randomUUID();
  const meta: RecordingMeta = { id, userId: scope.userId!, localEpoch: scope.epoch, consentVersion: 1, sessionId: "synthetic", planIndex: 0, kind: "main", followUpId: null, promptText: "Synthetic fragment", mimeType: "audio/webm", createdAt: Date.now(), durationMs: 3000, status, interrupted: true, recordingGuard: RECORDING_GUARD };
  await saveMeta(meta); await putChunk(id, 0, new Blob(["synthetic-only"]));
  const row: PendingUploadDiscard = { id: `discard:${meta.sessionId}:${id}`, kind: "upload-discard", userId: scope.userId!, epoch: scope.epoch, consentVersion: 1, sessionId: meta.sessionId, submissionId: id, eventId: crypto.randomUUID(), savedAt: Date.now() }; return { scope, meta, row };
}
afterEach(async () => { await endLocalAccount(null); vi.unstubAllGlobals(); });
it("memory-limited discard removes the fragment but truthfully reports no durable cancellation", async () => {
  const { meta, row } = await setup(); expect(await stageRecordingDiscard(row)).toBe(false); expect(await getMeta(meta.id)).toBeUndefined(); expect(await getBlob(meta.id, meta.mimeType)).toBeNull(); expect(await listPendingUploadDiscards()).toEqual([row]);
});
it("an old acknowledgement cannot erase a newer cancellation", async () => {
  const { row } = await setup(); await stageRecordingDiscard(row); const next = { ...row, eventId: crypto.randomUUID(), savedAt: Date.now() }; await stageRecordingDiscard(next); await deletePendingUploadDiscard(row); expect(await listPendingUploadDiscards()).toEqual([next]); await deletePendingUploadDiscard(next); expect(await listPendingUploadDiscards()).toEqual([]);
});
it("consent revision clears cancellation tasks and old tasks cannot return after reconsent", async () => {
  const { row } = await setup(); await stageRecordingDiscard(row); await syncLocalRecordingConsent(row.userId, { allowed: false, version: 2 }); await syncLocalRecordingConsent(row.userId, { allowed: true, version: 3 }); expect(await listPendingUploadDiscards()).toEqual([]); await expect(stageRecordingDiscard(row)).rejects.toThrow("录音授权");
});
it("logout and account switch reject old cancellation writes", async () => {
  const { row, scope } = await setup(); await stageRecordingDiscard(row); await endLocalAccount(scope); await activateLocalAccount("discard-other", undefined, { allowed: true, version: 1 }); expect(await listPendingUploadDiscards()).toEqual([]); await expect(stageRecordingDiscard(row)).rejects.toThrow(); expect(localIdentity()?.userId).toBe("discard-other");
});
it("invalid time or identity cannot discard a fragment, and a live owner lock keeps its audio", async () => {
  const { meta, row } = await setup("recording");
  for (const bad of [{ ...row, savedAt: Date.now() + 120000 }, { ...row, savedAt: Date.now() - 86400_001 }, { ...row, epoch: "other-epoch" }, { ...row, sessionId: "other-session" }]) await expect(stageRecordingDiscard(bad)).rejects.toThrow();
  const occupied = new Set<string>(); vi.stubGlobal("navigator", { locks: { request: async (name: string, _: unknown, callback: (lock: object | null) => unknown) => { if (occupied.has(name)) return callback(null); occupied.add(name); try { return await callback({ name }); } finally { occupied.delete(name); } } } });
  const ownership = await holdRecording(meta.id); try { await expect(stageRecordingDiscard(row)).rejects.toThrow("仍在录音"); expect(await getMeta(meta.id)).toBeDefined(); expect(await listPendingUploadDiscards()).toEqual([]); } finally { ownership.release(); }
  await stageRecordingDiscard(row); expect(await getMeta(meta.id)).toBeUndefined();
});
