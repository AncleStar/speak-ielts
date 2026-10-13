"use client";
import { assertRecordingSnapshotScope, readRecordingSnapshot, type RecordingSnapshot } from "./idb";
import { PRIVATE_SESSION_EVENT, RECORDING_CONSENT_EVENT } from "./private-session";

const activeUrls = new Set<string>();
let listening = false;
async function download(snapshot: RecordingSnapshot, body: Blob, filename: string) {
  await assertRecordingSnapshotScope(snapshot.scope);
  if (!listening) { listening = true; const clear = () => { for (const url of activeUrls) URL.revokeObjectURL(url); activeUrls.clear(); }; window.addEventListener(PRIVATE_SESSION_EVENT, clear); window.addEventListener(RECORDING_CONSENT_EVENT, clear); }
  const url = URL.createObjectURL(body), anchor = document.createElement("a"); activeUrls.add(url);
  anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => { URL.revokeObjectURL(url); activeUrls.delete(url); }, 60000);
}
function filename(snapshot: RecordingSnapshot, extension: string) { return `speak-recording-${new Date(snapshot.meta.createdAt).toISOString().replace(/[:.]/g, "-")}-${snapshot.meta.id.slice(0, 12).replace(/[^a-zA-Z0-9_-]/g, "_")}.${extension}`; }
export async function downloadRecordingAudio(id: string) {
  const snapshot = await readRecordingSnapshot(id); if (!snapshot?.blob.size) throw new Error("没有可下载的录音分片。");
  if (snapshot.chunks.some((c, i) => c.seq !== i)) throw new Error("分片不连续，请下载原始备份以保留全部数据。");
  const mime = snapshot.meta.mimeType.split(";")[0], ext = ({ "audio/webm": "webm", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav" } as Record<string, string>)[mime] ?? "bin";
  await download(snapshot, snapshot.blob, filename(snapshot, ext));
}
/** Raw backup keeps every stored sequence, including gaps; no identity/session credentials are exported. */
export async function downloadRecordingBackup(id: string) {
  const snapshot = await readRecordingSnapshot(id); if (!snapshot?.blob.size) throw new Error("没有可备份的录音分片。");
  const chunks = [];
  for (const c of snapshot.chunks) {
    const bytes = new Uint8Array(await c.blob.arrayBuffer()); let binary = "";
    for (let n = 0; n < bytes.length; n += 8192) binary += String.fromCharCode(...bytes.subarray(n, n + 8192));
    chunks.push({ sequence: c.seq, bytes: bytes.length, base64: btoa(binary) });
  }
  const m = snapshot.meta;
  const body = { format: "speak-local-recording-v1", capturedAt: snapshot.capturedAt, incomplete: m.status === "recording" || m.interrupted, metadata: { sessionId: m.sessionId, planIndex: m.planIndex, kind: m.kind, followUpId: m.followUpId, promptText: m.promptText, mimeType: m.mimeType, recordedAt: m.createdAt, durationEstimateMs: m.durationMs }, chunks };
  await download(snapshot, new Blob([JSON.stringify(body)], { type: "application/json" }), filename(snapshot, "speak-recording.json"));
}
