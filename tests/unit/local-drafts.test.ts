import { expect, it } from "vitest";
import { DRAFT_TTL_MS, validDraft, type ThoughtDraft } from "@/lib/thoughts/draft";
import { activateLocalAccount, endLocalAccount, getBlob, listRecordings, listThoughtDrafts, localIdentity, putChunk, removeThoughtDrafts, saveMeta, saveThoughtDraft, type RecordingMeta } from "@/lib/client/idb";
const owner = "local-alice", epoch = crypto.randomUUID(), now = Date.now();
const draft: ThoughtDraft = { id: crypto.randomUUID(), kind: "edit", userId: owner, localEpoch: epoch, savedAt: now, thoughtId: null, revision: null,
  fields: { sourceText: "我的未完成观点", title: "", simple: "", natural: "", nuanced: "" }, generation: null };
it("accepts incomplete text but refuses wrong accounts, revoked epochs and expired or future drafts", () => {
  expect(validDraft(draft, owner, epoch, now)).toBeTruthy();
  expect(validDraft(draft, "other-account", epoch, now)).toBeNull(); expect(validDraft(draft, owner, crypto.randomUUID(), now)).toBeNull();
  expect(validDraft(draft, owner, epoch, now + DRAFT_TTL_MS)).toBeNull(); expect(validDraft({ ...draft, savedAt: now + 120_000 }, owner, epoch, now)).toBeNull();
});
it("rejects oversized input and inconsistent references; recall cache cannot contain an audio blob", () => {
  expect(validDraft({ ...draft, fields: { ...draft.fields, natural: "x".repeat(2001) } }, owner, epoch, now)).toBeNull();
  expect(validDraft({ ...draft, revision: 0 }, owner, epoch, now)).toBeNull();
  expect(validDraft({ ...draft, kind: "recall", thoughtId: "thought-a", revision: 0, recalledText: "My attempted expression.", pending: null, audio: "private-audio" }, owner, epoch, now)).not.toHaveProperty("audio");
});
it("a logout clears fallback data and old asynchronous writers cannot revive it after relogin", async () => {
  const scope = await activateLocalAccount(owner);
  const meta: RecordingMeta = { id: "local-test-recording", userId: owner, sessionId: "local-test-session", planIndex: 0, kind: "main", followUpId: null,
    promptText: "synthetic only", mimeType: "audio/wav", durationMs: 6000, createdAt: now, status: "pending", interrupted: false };
  await saveMeta(meta); await putChunk(meta.id, 0, new Blob(["synthetic-only"]));
  await saveThoughtDraft({ ...draft, localEpoch: scope.epoch });
  expect(await listRecordings()).toHaveLength(1); expect(await listThoughtDrafts()).toHaveLength(1);
  await endLocalAccount(scope); await activateLocalAccount(owner);
  expect(localIdentity()?.epoch).not.toBe(scope.epoch); expect(await getBlob(meta.id, meta.mimeType)).toBeNull();
  await expect(saveMeta(meta)).rejects.toThrow("当前登录已结束"); await expect(putChunk(meta.id, 1, new Blob(["late chunk"]))).rejects.toThrow("当前登录已结束");
  await expect(saveThoughtDraft({ ...draft, localEpoch: scope.epoch })).rejects.toThrow("当前登录已结束");
  expect(await listRecordings()).toEqual([]); expect(await listThoughtDrafts()).toEqual([]);
});
it("a delayed cleanup from an old login does not erase the new account's data", async () => {
  const alice = await activateLocalAccount(owner), bob = await activateLocalAccount("local-bob");
  await saveThoughtDraft({ ...draft, userId: "local-bob", localEpoch: bob.epoch });
  await endLocalAccount(alice);
  expect(localIdentity()?.userId).toBe("local-bob"); expect(await listThoughtDrafts()).toHaveLength(1);
  await endLocalAccount(bob);
});
it("a deleted thought's draft cannot be recreated by a stale writer in this login", async () => {
  const scope = await activateLocalAccount(owner), saved = { ...draft, localEpoch: scope.epoch, thoughtId: "deleted-thought", revision: 0 };
  await saveThoughtDraft(saved); expect(await listThoughtDrafts()).toHaveLength(1);
  await removeThoughtDrafts("deleted-thought"); expect(await listThoughtDrafts()).toEqual([]);
  await expect(saveThoughtDraft({ ...saved, savedAt: Date.now() })).rejects.toThrow("这份观点已删除");
  expect(await listThoughtDrafts()).toEqual([]); await endLocalAccount(scope);
});
