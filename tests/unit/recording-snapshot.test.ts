import { afterEach, expect, it, vi } from "vitest";
import { activateLocalAccount, copyRecordingSnapshot, endLocalAccount, getBlob, getMeta, listRecordings, putChunk, readRecordingSnapshot, saveMeta, syncLocalRecordingConsent, type RecordingMeta } from "@/lib/client/idb";
async function setup() {
  const scope = await activateLocalAccount("snapshot-unit", undefined, { allowed: true, version: 1 });
  const meta: RecordingMeta = { id: crypto.randomUUID(), userId: scope.userId!, localEpoch: scope.epoch, consentVersion: 1, activationId: "original-recording-batch", sessionId: "synthetic", planIndex: 0, kind: "main", followUpId: null, promptText: "Synthetic snapshot", mimeType: "audio/webm", createdAt: Date.now() - 60000, durationMs: 3000, status: "recording", interrupted: false };
  await saveMeta(meta); await putChunk(meta.id, 0, new Blob(["first-chunk"])); return { scope, meta };
}
afterEach(async () => { await endLocalAccount(null); vi.unstubAllGlobals(); });
it("copies unverified fragments without modifying their owner, status, chunks or original expiry", async () => {
  const { meta } = await setup(), copied = await copyRecordingSnapshot(meta.id);
  expect(copied.meta).toMatchObject({ status: "pending", interrupted: true, snapshotOf: meta.id, createdAt: meta.createdAt, activationId: meta.activationId });
  expect(await getMeta(meta.id)).toEqual(meta); expect(await (await getBlob(meta.id, meta.mimeType))?.text()).toBe("first-chunk");
  expect(await copied.blob.text()).toBe("first-chunk");
});
it("concurrent copies of one immutable prefix converge on one submission and newer original chunks do not mutate it", async () => {
  const { meta } = await setup(), [one, two] = await Promise.all([copyRecordingSnapshot(meta.id), copyRecordingSnapshot(meta.id)]);
  expect(one.meta.id).toBe(two.meta.id); expect((await listRecordings()).filter(m => m.snapshotOf)).toHaveLength(1);
  await putChunk(meta.id, 1, new Blob(["-second-chunk"])); const later = await copyRecordingSnapshot(meta.id); expect(later.meta.id).not.toBe(one.meta.id);
  expect(await (await getBlob(one.meta.id, meta.mimeType))?.text()).toBe("first-chunk"); expect(await later.blob.text()).toBe("first-chunk-second-chunk");
});
it("refuses incomplete sequence numbers without changing or deleting any original byte", async () => {
  const { meta } = await setup(); await putChunk(meta.id, 2, new Blob(["gap-chunk"]));
  await expect(copyRecordingSnapshot(meta.id)).rejects.toThrow("分片不连续"); expect((await readRecordingSnapshot(meta.id))?.chunks.map(c => c.seq)).toEqual([0, 2]); expect(await getMeta(meta.id)).toEqual(meta);
});
it("empty and oversized files do not create imaginary copies", async () => {
  const { meta } = await setup(), empty = { ...meta, id: crypto.randomUUID() }; await saveMeta(empty);
  await expect(copyRecordingSnapshot(empty.id)).rejects.toThrow("没有已写入");
  await putChunk(meta.id, 1, new Blob([new Uint8Array(25 * 1024 * 1024)])); await expect(copyRecordingSnapshot(meta.id)).rejects.toThrow("25 MB"); expect((await listRecordings()).filter(m => m.snapshotOf)).toHaveLength(0);
});
it("does not extend expiry or revive an old copy after consent is withdrawn and granted again", async () => {
  const { scope, meta } = await setup(); await copyRecordingSnapshot(meta.id); await syncLocalRecordingConsent(scope.userId!, { allowed: false, version: 2 }); await syncLocalRecordingConsent(scope.userId!, { allowed: true, version: 3 });
  await expect(copyRecordingSnapshot(meta.id)).rejects.toThrow("状态已改变"); expect(await getBlob(meta.id, meta.mimeType)).toBeNull(); expect(await listRecordings()).toEqual([]);
});
it("an account switch during async fingerprinting cancels the copy and cannot populate the new account", async () => {
  const { scope, meta } = await setup(); const original = crypto.subtle.digest.bind(crypto.subtle);
  const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => { await endLocalAccount(scope); await activateLocalAccount("snapshot-other", undefined, { allowed: true, version: 1 }); return original(...args); });
  try { await expect(copyRecordingSnapshot(meta.id)).rejects.toThrow("登录已结束"); expect(await listRecordings()).toEqual([]); } finally { spy.mockRestore(); }
});
it("refuses expired fragments without silently extending their creation time", async () => {
  const { meta } = await setup(), expired = { ...meta, createdAt: Date.now() - 86400_001 }; await saveMeta(expired);
  await expect(copyRecordingSnapshot(meta.id)).rejects.toThrow("24 小时"); expect(await getMeta(meta.id)).toEqual(expired);
});
