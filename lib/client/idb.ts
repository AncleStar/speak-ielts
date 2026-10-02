"use client";

/**
 * 录音本地暂存（IndexedDB）：每 1 秒一个片段写入；服务器确认接收后删除本地副本。
 * 未上传成功的录音最多保留 24 小时。浏览器禁用本地存储时退化为内存暂存，并提示恢复能力受限。
 */

export interface RecordingMeta {
  userId?: string;
  id: string; // = submissionId
  sessionId: string;
  planIndex: number;
  kind: "main" | "followup" | "rounding";
  followUpId: string | null;
  promptText: string;
  mimeType: string;
  durationMs: number;
  createdAt: number;
  status: "recording" | "pending" | "failed";
  interrupted: boolean;
  lastError?: string;
}

const DB_NAME = "ielts-recordings";
const VERSION = 1;
export const LOCAL_TTL_MS = 24 * 3600 * 1000;

let dbPromise: Promise<IDBDatabase | null> | null = null;
const memMeta = new Map<string, RecordingMeta>();
const memChunks = new Map<string, Blob[]>();
let persistent = true;

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        persistent = false;
        return resolve(null);
      }
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("recordings")) db.createObjectStore("recordings", { keyPath: "id" });
        if (!db.objectStoreNames.contains("chunks")) {
          const s = db.createObjectStore("chunks", { keyPath: ["recId", "seq"] });
          s.createIndex("recId", "recId");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        persistent = false;
        resolve(null);
      };
      req.onblocked = () => {
        persistent = false;
        resolve(null);
      };
    } catch {
      persistent = false;
      resolve(null);
    }
  });
  return dbPromise;
}

export async function isPersistent() {
  await open();
  return persistent;
}

function tx<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result: T | undefined;
    const r = fn(t);
    if (r) r.onsuccess = () => (result = r.result);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function saveMeta(meta: RecordingMeta) {
  memMeta.set(meta.id, meta);
  const db = await open();
  if (!db) return;
  try {
    await tx(db, ["recordings"], "readwrite", (t) => t.objectStore("recordings").put(meta));
  } catch {
    /* 写入失败时仍保留内存副本 */
    persistent = false;
    window.dispatchEvent(new Event("recording-storage-limited"));
  }
}

export async function updateMeta(id: string, patch: Partial<RecordingMeta>) {
  const cur = memMeta.get(id) ?? (await getMeta(id));
  if (!cur) return;
  await saveMeta({ ...cur, ...patch });
}

export async function getMeta(id: string): Promise<RecordingMeta | undefined> {
  const db = await open();
  if (!db) return memMeta.get(id);
  try {
    return (await tx<RecordingMeta>(db, ["recordings"], "readonly", (t) => t.objectStore("recordings").get(id))) ?? memMeta.get(id);
  } catch {
    return memMeta.get(id);
  }
}

export async function putChunk(recId: string, seq: number, blob: Blob) {
  const list = memChunks.get(recId) ?? [];
  list[seq] = blob;
  memChunks.set(recId, list);
  const db = await open();
  if (!db) return;
  try {
    await tx(db, ["chunks"], "readwrite", (t) => t.objectStore("chunks").put({ recId, seq, blob }));
  } catch {
    /* 空间不足等情况：保留内存副本 */
    persistent = false;
    window.dispatchEvent(new Event("recording-storage-limited"));
  }
}

export async function getBlob(recId: string, mimeType: string): Promise<Blob | null> {
  const mem = memChunks.get(recId);
  if (mem && mem.length) return new Blob(mem.filter(Boolean), { type: mimeType });
  const db = await open();
  if (!db) return null;
  try {
    const rows = await new Promise<{ seq: number; blob: Blob }[]>((resolve, reject) => {
      const t = db.transaction(["chunks"], "readonly");
      const req = t.objectStore("chunks").index("recId").getAll(IDBKeyRange.only(recId));
      req.onsuccess = () => resolve(req.result as { seq: number; blob: Blob }[]);
      req.onerror = () => reject(req.error);
    });
    if (!rows.length) return null;
    rows.sort((a, b) => a.seq - b.seq);
    return new Blob(rows.map((r) => r.blob), { type: mimeType });
  } catch {
    return null;
  }
}

export async function listRecordings(sessionId?: string): Promise<RecordingMeta[]> {
  const db = await open();
  let rows: RecordingMeta[] = [];
  if (db) {
    try {
      rows = (await tx<RecordingMeta[]>(db, ["recordings"], "readonly", (t) => t.objectStore("recordings").getAll())) ?? [];
    } catch {
      /* ignore */
    }
  }
  const uniq = new Map<string, RecordingMeta>();
  for (const m of rows) uniq.set(m.id, m);
  for (const m of memMeta.values()) uniq.set(m.id, m);
  return [...uniq.values()].filter((m) => !sessionId || m.sessionId === sessionId).sort((a, b) => a.createdAt - b.createdAt);
}

export async function deleteRecording(id: string) {
  memMeta.delete(id);
  memChunks.delete(id);
  const db = await open();
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(["recordings", "chunks"], "readwrite");
      t.objectStore("recordings").delete(id);
      const idx = t.objectStore("chunks").index("recId");
      const req = idx.openKeyCursor(IDBKeyRange.only(id));
      req.onsuccess = () => {
        const c = req.result;
        if (c) {
          t.objectStore("chunks").delete(c.primaryKey);
          c.continue();
        }
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch {
    /* ignore */
  }
}

/** 清理超过 24 小时的本地录音 */
export async function purgeExpired(now = Date.now()) {
  const all = await listRecordings();
  for (const m of all) if (now - m.createdAt > LOCAL_TTL_MS) await deleteRecording(m.id);
}
