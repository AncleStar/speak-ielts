import { expect, it } from "vitest";
import { activateLocalAccount, deletePendingPause, endLocalAccount, listPendingPauses, savePendingPause, syncLocalRecordingConsent, type LocalIdentity, type PendingSessionPause } from "@/lib/client/idb";
const make = (scope: LocalIdentity, version = 0): PendingSessionPause => ({ id: "pause:synthetic-session", kind: "session-pause", userId: scope.userId!, epoch: scope.epoch, consentVersion: scope.consentVersion!, sessionId: "synthetic-session", eventId: crypto.randomUUID(), expectedVersion: version, pendingUploads: [], savedAt: Date.now() });
it("a delayed acknowledgement cannot remove a newer exit or replace its state version", async () => {
  const scope = await activateLocalAccount("pause-unit-a", undefined, { allowed: true, version: 1 }), old = make(scope), newer = make(scope, 2);
  await savePendingPause(old); await savePendingPause(newer); await deletePendingPause(old); await savePendingPause(old);
  expect(await listPendingPauses()).toEqual([newer]); await endLocalAccount(scope);
});
it("logout/account switches clear pending exits and old writers cannot revive them", async () => {
  const alice = await activateLocalAccount("pause-unit-a", undefined, { allowed: true, version: 1 }), row = make(alice); await savePendingPause(row);
  await endLocalAccount(alice); const bob = await activateLocalAccount("pause-unit-b", undefined, { allowed: true, version: 1 });
  expect(await listPendingPauses()).toEqual([]); await expect(savePendingPause(row)).rejects.toThrow("录音授权");
  await endLocalAccount(alice); expect((await listPendingPauses())).toEqual([]); await endLocalAccount(bob);
});
it("withdrawal/reconsent invalidates the old exit; malformed or future records cannot overwrite login metadata", async () => {
  const scope = await activateLocalAccount("pause-unit-c", undefined, { allowed: true, version: 1 }), row = make(scope); await savePendingPause(row);
  await syncLocalRecordingConsent(scope.userId!, { allowed: false, version: 2 }); expect(await listPendingPauses()).toEqual([]);
  await syncLocalRecordingConsent(scope.userId!, { allowed: true, version: 3 }); await expect(savePendingPause(row)).rejects.toThrow("录音授权");
  const fresh = await activateLocalAccount(scope.userId!, undefined, { allowed: true, version: 3 });
  await expect(savePendingPause({ ...make(fresh), id: "current" })).rejects.toThrow("录音授权");
  await expect(savePendingPause({ ...make(fresh), savedAt: Date.now() + 120_000 })).rejects.toThrow("录音授权"); await endLocalAccount(fresh);
});
