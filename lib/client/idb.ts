"use client";
import { validDraft, type ThoughtDraft } from "@/lib/thoughts/draft";

/** Every private write checks its login epoch in the same IndexedDB transaction. */
export interface RecordingMeta {
  userId?: string; localEpoch?: string; consentVersion?: number; id: string; sessionId: string; planIndex: number;
  kind: "main" | "followup" | "rounding"; followUpId: string | null; promptText: string; mimeType: string;
  durationMs: number; createdAt: number; status: "recording" | "pending" | "failed"; interrupted: boolean; lastError?: string;
}
export interface RecordingConsentState { allowed: boolean; version: number }
export interface LocalIdentity { id: "current"; userId: string | null; epoch: string; consentAllowed?: boolean; consentVersion?: number }
export class LocalSessionEnded extends Error { constructor() { super("当前登录已结束，请重新登录。"); } }
export class LocalConsentEnded extends LocalSessionEnded { constructor() { super(); this.message = "录音授权已撤回或改变，请重新同意后开始新录音。"; } }
export class LocalThoughtDeleted extends Error { constructor() { super("这份观点已删除，相关草稿不会继续暂存。请新建观点。"); } }
export const THOUGHT_DRAFT_SIGNAL = "speak-thought-drafts-change";
const DB_NAME = "ielts-recordings", VERSION = 2, PRIVATE_STORES = ["recordings", "chunks", "thoughtDrafts", "privateSession"];
export const LOCAL_TTL_MS = 24 * 3600_000;
let dbPromise: Promise<IDBDatabase | null> | null = null, identity: LocalIdentity | null = null, memoryIdentity: LocalIdentity | null = null, persistent = true;
const memMeta = new Map<string, RecordingMeta>(), memChunks = new Map<string, Blob[]>(), memDrafts = new Map<string, ThoughtDraft>();
const memDeletedThoughts = new Set<string>();
function limited() { persistent = false; if (typeof window !== "undefined") window.dispatchEvent(new Event("recording-storage-limited")); }
function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    let settled = false;
    const unavailable = () => { if (!settled) { settled = true; limited(); resolve(null); } };
    try {
      if (typeof indexedDB === "undefined") { unavailable(); return; }
      const request = indexedDB.open(DB_NAME, VERSION);
      request.onupgradeneeded = () => { const db = request.result;
        if (!db.objectStoreNames.contains("recordings")) db.createObjectStore("recordings", { keyPath: "id" });
        if (!db.objectStoreNames.contains("chunks")) { const store = db.createObjectStore("chunks", { keyPath: ["recId", "seq"] }); store.createIndex("recId", "recId"); }
        if (!db.objectStoreNames.contains("thoughtDrafts")) db.createObjectStore("thoughtDrafts", { keyPath: "id" });
        if (!db.objectStoreNames.contains("privateSession")) db.createObjectStore("privateSession", { keyPath: "id" });
      };
      request.onsuccess = () => { const db = request.result; if (settled) { db.close(); return; } settled = true; db.onversionchange = () => { db.close(); dbPromise = null; }; resolve(db); };
      request.onerror = unavailable;
      request.onblocked = unavailable;
    } catch { unavailable(); }
  }); return dbPromise;
}
export async function isPersistent() { await open(); return persistent; }
export function localIdentity() { return identity?.userId ? { ...identity } : null; }
export function recordingPermitted() { return !!identity?.userId && identity.consentAllowed === true; }
export function invalidateLocalMemory() { identity = null; memMeta.clear(); memChunks.clear(); memDrafts.clear(); memDeletedThoughts.clear(); }
function matches(a: LocalIdentity | null | undefined, b: LocalIdentity | null | undefined) { return !!a && !!b && a.userId === b.userId && a.epoch === b.epoch; }
function transaction<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, work: (t: IDBTransaction, result: (v: T) => void, fail: (e: Error) => void) => void) {
  return new Promise<T>((resolve, reject) => {
    let result: T, failure: Error | null = null;
    const t = db.transaction(stores, mode);
    t.oncomplete = () => resolve(result!); t.onerror = () => reject(failure ?? t.error ?? new Error("浏览器存储操作失败")); t.onabort = () => reject(failure ?? t.error ?? new Error("浏览器存储操作被取消"));
    const fail = (error: Error) => { failure = error; t.abort(); };
    try { work(t, v => { result = v; }, fail); } catch (error) { fail(error instanceof Error ? error : new Error("浏览器存储操作失败")); }
  });
}
async function write(stores: string[], scope: LocalIdentity, work: (t: IDBTransaction, fail: (e: Error) => void) => void) {
  const audio = stores.includes("recordings") || stores.includes("chunks");
  const checkConsent = (current: LocalIdentity | null | undefined) => { if (audio && (current?.consentAllowed !== true || current.consentVersion !== scope.consentVersion)) throw new LocalConsentEnded(); };
  if (!scope.userId || !matches(scope, identity)) throw new LocalSessionEnded();
  checkConsent(identity);
  const db = await open(); if (!matches(scope, identity)) throw new LocalSessionEnded(); if (!db) return false;
  checkConsent(identity);
  try {
    await transaction<void>(db, [...new Set(["privateSession", ...stores])], "readwrite", (t, done, fail) => {
      const request = t.objectStore("privateSession").get("current");
      request.onsuccess = () => {
        if (!matches(request.result, scope)) { fail(new LocalSessionEnded()); return; }
        try { checkConsent(request.result); } catch (e) { fail(e as Error); return; }
        try { work(t, fail); done(); } catch (error) { fail(error instanceof Error ? error : new Error("浏览器存储操作失败")); }
      };
    });
    if (!matches(scope, identity)) throw new LocalSessionEnded(); checkConsent(identity); return true;
  } catch (error) { if (error instanceof LocalSessionEnded || error instanceof LocalThoughtDeleted) throw error; limited(); return false; }
}
async function all<T>(store: string): Promise<T[]> {
  const db = await open(); if (!db) return [];
  return transaction<T[]>(db, [store], "readonly", (t, done) => { const request = t.objectStore(store).getAll(); request.onsuccess = () => done(request.result); }).catch(() => { limited(); return []; });
}
export async function readLocalIdentity(): Promise<LocalIdentity | null> {
  const db = await open(); if (!db) return memoryIdentity;
  return transaction<LocalIdentity | null>(db, ["privateSession"], "readonly", (t, done) => { const request = t.objectStore("privateSession").get("current"); request.onsuccess = () => done(request.result ?? null); });
}
export async function activateLocalAccount(userId: string, signal?: AbortSignal, consent: RecordingConsentState = { allowed: false, version: 0 }) {
  const db = await open(); let selected: LocalIdentity;
  const observed = db ? await readLocalIdentity() : null;
  const legacyOwned = new Set<string>();
  if (db) for (const row of await all<RecordingMeta>("recordings")) if (!row.userId && Date.now() - row.createdAt < LOCAL_TTL_MS) {
    try { const response = await fetch(`/api/sessions/${encodeURIComponent(row.sessionId)}`, { cache: "no-store", signal: signal ?? AbortSignal.timeout(5000) }); if (response.ok) legacyOwned.add(row.id); } catch { /* keep unidentified old recordings hidden until ownership can be checked */ }
  }
  signal?.throwIfAborted();
  const nextConsent = (previous: LocalIdentity | undefined | null) => previous?.userId === userId && (previous.consentVersion ?? -1) > consent.version ? { consentAllowed: previous.consentAllowed, consentVersion: previous.consentVersion } : { consentAllowed: consent.allowed, consentVersion: consent.version };
  if (!db) selected = { ...(memoryIdentity?.userId === userId ? memoryIdentity : { id: "current" as const, userId, epoch: crypto.randomUUID() }), ...nextConsent(memoryIdentity) };
  else selected = await transaction<LocalIdentity>(db, PRIVATE_STORES, "readwrite", (t, done, fail) => {
    const request = t.objectStore("privateSession").get("current"); request.onsuccess = () => {
      const previous = request.result as LocalIdentity | undefined;
      if (observed ? !matches(observed, previous) : !!previous && previous.userId !== userId) { fail(new LocalSessionEnded()); return; }
      const next: LocalIdentity = { ...(previous?.userId === userId ? previous : { id: "current" as const, userId, epoch: crypto.randomUUID() }), ...nextConsent(previous) };
      if (previous?.epoch !== next.epoch) t.objectStore("privateSession").clear();
      t.objectStore("privateSession").put(next); const allowed = new Set<string>();
      const rows = t.objectStore("recordings").openCursor(); rows.onsuccess = () => {
        const cursor = rows.result;
        if (cursor) { const row = cursor.value as RecordingMeta;
          if (!row.userId && !legacyOwned.has(row.id) && !previous?.userId && Date.now() - row.createdAt < LOCAL_TTL_MS) allowed.add(row.id);
          else if (!next.consentAllowed || (row.consentVersion !== undefined && row.consentVersion !== next.consentVersion) || (row.userId && row.userId !== userId) || (row.localEpoch && row.localEpoch !== next.epoch) || Date.now() - row.createdAt >= LOCAL_TTL_MS || (!row.userId && !legacyOwned.has(row.id))) cursor.delete();
          else { allowed.add(row.id); if (!row.localEpoch || !row.userId || row.consentVersion === undefined) cursor.update({ ...row, userId, localEpoch: next.epoch, consentVersion: next.consentVersion }); }
          cursor.continue();
        } else {
          const chunks = t.objectStore("chunks").openCursor(); chunks.onsuccess = () => { const chunk = chunks.result; if (chunk) { if (!allowed.has(chunk.value.recId)) chunk.delete(); chunk.continue(); } };
        }
      };
      const drafts = t.objectStore("thoughtDrafts").openCursor(); drafts.onsuccess = () => { const cursor = drafts.result; if (cursor) { if (!validDraft(cursor.value, userId, next.epoch)) cursor.delete(); cursor.continue(); } };
      done(next);
    };
  });
  signal?.throwIfAborted();
  if (!matches(selected, identity)) invalidateLocalMemory(); else if (selected.consentVersion !== identity?.consentVersion || !selected.consentAllowed) { memMeta.clear(); memChunks.clear(); } identity = selected; memoryIdentity = selected; return selected;
}
/** Monotone consent revisions stop delayed responses from re-enabling an old recording; text scope remains unchanged. */
export async function syncLocalRecordingConsent(userId: string, consent: RecordingConsentState) {
  const db = await open();
  const apply = (previous: LocalIdentity | null | undefined) => {
    if (!previous || previous.userId !== userId || (previous.consentVersion ?? -1) > consent.version) return previous ?? null;
    return { ...previous, consentAllowed: consent.allowed, consentVersion: consent.version };
  };
  const next = db ? await transaction<LocalIdentity | null>(db, ["privateSession", "recordings", "chunks"], "readwrite", (t, done) => {
    const request = t.objectStore("privateSession").get("current"); request.onsuccess = () => {
      const previous = request.result as LocalIdentity | undefined, next = apply(previous);
      if (next && next !== previous) {
        if (next.consentVersion !== previous?.consentVersion || !next.consentAllowed) { t.objectStore("recordings").clear(); t.objectStore("chunks").clear(); }
        t.objectStore("privateSession").put(next);
      } done(next);
    };
  }) : apply(memoryIdentity);
  if (matches(identity, next)) {
    if (next?.consentVersion !== identity?.consentVersion || !next?.consentAllowed) { memMeta.clear(); memChunks.clear(); }
    identity = next;
  }
  if (!memoryIdentity || matches(memoryIdentity, next)) memoryIdentity = next;
  return next;
}
/** Revoke only the captured login, protecting a concurrently activated new account. */
export async function endLocalAccount(expected: LocalIdentity | null) {
  if (!identity || (expected && matches(expected, identity))) invalidateLocalMemory();
  const next: LocalIdentity = { id: "current", userId: null, epoch: crypto.randomUUID() }, db = await open();
  if (!db) {
    if (!expected || matches(expected, memoryIdentity)) memoryIdentity = next;
    if (typeof indexedDB !== "undefined") throw new Error("浏览器未能清理本机私人资料，请关闭其他旧页面并在浏览器设置中清除本站数据。");
    return;
  }
  await transaction<void>(db, PRIVATE_STORES, "readwrite", (t, done) => {
    const request = t.objectStore("privateSession").get("current"); request.onsuccess = () => {
      if (expected ? matches(expected, request.result) : !request.result) {
        for (const store of ["recordings", "chunks", "thoughtDrafts"]) t.objectStore(store).clear();
        t.objectStore("privateSession").clear();
        t.objectStore("privateSession").put(next); memoryIdentity = next;
      } done();
    };
  });
}
function recordingOwned(meta: RecordingMeta | undefined, scope = identity) { return !!meta && !!scope?.userId && scope.consentAllowed === true && meta.userId === scope.userId && meta.localEpoch === scope.epoch && meta.consentVersion === scope.consentVersion; }
export async function saveMeta(meta: RecordingMeta) {
  const scope = localIdentity(); if (!scope || meta.userId !== scope.userId) throw new LocalSessionEnded();
  meta.localEpoch ??= scope.epoch; if (meta.localEpoch !== scope.epoch) throw new LocalSessionEnded(); meta.consentVersion ??= scope.consentVersion; if (!recordingOwned(meta, scope)) throw new LocalConsentEnded();
  await write(["recordings"], scope, t => { t.objectStore("recordings").put(meta); }); memMeta.set(meta.id, { ...meta });
}
export async function updateMeta(id: string, patch: Partial<RecordingMeta>) { const current = await getMeta(id); if (current) await saveMeta({ ...current, ...patch, userId: current.userId, localEpoch: current.localEpoch, consentVersion: current.consentVersion }); }
export async function getMeta(id: string): Promise<RecordingMeta | undefined> {
  const memory = memMeta.get(id); if (recordingOwned(memory)) return memory;
  const db = await open(); if (!db || !identity?.userId) return;
  const row = await transaction<RecordingMeta | undefined>(db, ["recordings"], "readonly", (t, done) => { const request = t.objectStore("recordings").get(id); request.onsuccess = () => done(request.result); }).catch(() => undefined);
  return recordingOwned(row) ? row : undefined;
}
export async function putChunk(recId: string, seq: number, blob: Blob) {
  const scope = localIdentity(), meta = await getMeta(recId); if (!scope || !recordingOwned(meta, scope)) throw new LocalSessionEnded();
  await write(["chunks"], scope, t => { t.objectStore("chunks").put({ recId, seq, blob }); });
  const list = memChunks.get(recId) ?? []; list[seq] = blob; memChunks.set(recId, list);
}
export async function getBlob(recId: string, mimeType: string): Promise<Blob | null> {
  if (!await getMeta(recId)) return null;
  const memory = memChunks.get(recId); if (memory?.length) return new Blob(memory.filter(Boolean), { type: mimeType });
  const db = await open(); if (!db) return null;
  const rows = await transaction<{ seq: number; blob: Blob }[]>(db, ["chunks"], "readonly", (t, done) => { const request = t.objectStore("chunks").index("recId").getAll(IDBKeyRange.only(recId)); request.onsuccess = () => done(request.result); });
  rows.sort((a, b) => a.seq - b.seq);
  return rows.length ? new Blob(rows.map(row => row.blob), { type: mimeType }) : null;
}
export async function listRecordings(sessionId?: string) {
  if (!identity?.userId) return [];
  const rows = new Map<string, RecordingMeta>(); for (const row of await all<RecordingMeta>("recordings")) rows.set(row.id, row);
  for (const row of memMeta.values()) rows.set(row.id, row);
  return [...rows.values()].filter(row => recordingOwned(row) && (!sessionId || row.sessionId === sessionId)).sort((a, b) => a.createdAt - b.createdAt);
}
export async function deleteRecording(id: string) {
  const scope = localIdentity(); if (!scope || !await getMeta(id)) return;
  await write(["recordings", "chunks"], scope, t => {
    t.objectStore("recordings").delete(id); const request = t.objectStore("chunks").index("recId").openKeyCursor(IDBKeyRange.only(id));
    request.onsuccess = () => { const cursor = request.result; if (cursor) { t.objectStore("chunks").delete(cursor.primaryKey); cursor.continue(); } };
  }); memMeta.delete(id); memChunks.delete(id);
}
export async function purgeExpired(now = Date.now()) { for (const meta of await listRecordings()) if (now - meta.createdAt >= LOCAL_TTL_MS) await deleteRecording(meta.id); }
export async function saveThoughtDraft(draft: ThoughtDraft) {
  const scope = localIdentity(), clean = scope?.userId ? validDraft(draft, scope.userId, scope.epoch) : null; if (!scope || !clean) throw new LocalSessionEnded();
  if (clean.thoughtId && memDeletedThoughts.has(clean.thoughtId)) throw new LocalThoughtDeleted();
  const saved = await write(["thoughtDrafts"], scope, (t, fail) => {
    if (!clean.thoughtId) { t.objectStore("thoughtDrafts").put(clean); return; }
    const deleted = t.objectStore("privateSession").get(`deleted:${clean.thoughtId}`);
    deleted.onsuccess = () => {
      if (matches(deleted.result, scope)) { fail(new LocalThoughtDeleted()); return; }
      try { t.objectStore("thoughtDrafts").put(clean); } catch (error) { fail(error instanceof Error ? error : new Error("浏览器存储操作失败")); }
    };
  }); memDrafts.set(clean.id, clean); return saved;
}
async function deletedThoughts(scope: LocalIdentity) {
  const deleted = new Set(memDeletedThoughts);
  for (const row of await all<LocalIdentity & { thoughtId?: string }>("privateSession")) if (row.thoughtId && matches(row, scope)) deleted.add(row.thoughtId);
  return deleted;
}
export async function isThoughtDeleted(thoughtId: string) { const scope = localIdentity(); return !!scope && (await deletedThoughts(scope)).has(thoughtId); }
/** Keep a tombstone for this login so a stale tab cannot recreate a deleted document's drafts. */
export async function removeThoughtDrafts(thoughtId: string) {
  const scope = localIdentity(); if (!scope) throw new LocalSessionEnded();
  const saved = await write(["thoughtDrafts"], scope, t => {
    t.objectStore("privateSession").put({ id: `deleted:${thoughtId}`, userId: scope.userId, epoch: scope.epoch, thoughtId });
    const request = t.objectStore("thoughtDrafts").openCursor(); request.onsuccess = () => { const cursor = request.result; if (cursor) { if (cursor.value.thoughtId === thoughtId) cursor.delete(); cursor.continue(); } };
  });
  memDeletedThoughts.add(thoughtId); for (const [id, row] of memDrafts) if (row.thoughtId === thoughtId) memDrafts.delete(id);
  try { const channel = new BroadcastChannel(THOUGHT_DRAFT_SIGNAL); channel.postMessage("changed"); channel.close(); } catch { /* storage and focus checks remain */ }
  try { localStorage.setItem(THOUGHT_DRAFT_SIGNAL, crypto.randomUUID()); } catch { /* storage may be disabled */ }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(THOUGHT_DRAFT_SIGNAL));
  return saved;
}
export async function listThoughtDrafts() {
  const scope = localIdentity(); if (!scope?.userId) return [];
  const deleted = await deletedThoughts(scope);
  const rows = new Map<string, ThoughtDraft>(); for (const row of await all<ThoughtDraft>("thoughtDrafts")) rows.set(row.id, row); for (const row of memDrafts.values()) rows.set(row.id, row);
  return [...rows.values()].map(row => validDraft(row, scope.userId!, scope.epoch)).filter((row): row is ThoughtDraft => !!row && (!row.thoughtId || !deleted.has(row.thoughtId))).sort((a, b) => b.savedAt - a.savedAt);
}
export async function deleteThoughtDraft(id: string, expected?: ThoughtDraft) {
  const scope = localIdentity(); if (!scope || !(await listThoughtDrafts()).some(row => row.id === id)) return;
  let removed = !expected || JSON.stringify(memDrafts.get(id)) === JSON.stringify(expected);
  const persisted = await write(["thoughtDrafts"], scope, t => {
    const store = t.objectStore("thoughtDrafts"), request = store.get(id);
    request.onsuccess = () => { removed = !expected || JSON.stringify(request.result) === JSON.stringify(expected); if (removed) store.delete(id); };
  });
  if (removed || (!persisted && !expected)) memDrafts.delete(id);
}
