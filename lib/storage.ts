import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";

export interface ObjectStat {
  size: number;
}

export interface StorageDriver {
  readonly name: "local" | "oss";
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  stat(key: string): Promise<ObjectStat | null>;
  /** 本地驱动返回可读流；OSS 返回 null（改用签名链接） */
  createReadStream(key: string, range?: { start: number; end: number }): NodeJS.ReadableStream | null;
  /** OSS：短期签名链接；本地：null（由鉴权接口直接输出） */
  signedUrl(key: string, expiresSec: number): Promise<string | null>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
  list(prefix: string): Promise<string[]>;
}

function safeKey(key: string) {
  if (!/^[A-Za-z0-9/_.\-]+$/.test(key) || key.includes("..") || key.startsWith("/")) {
    throw new Error(`非法的存储键：${key}`);
  }
  return key;
}

class LocalStorage implements StorageDriver {
  readonly name = "local" as const;
  constructor(private root: string) {}
  private p(key: string) {
    return path.join(this.root, ...safeKey(key).split("/"));
  }
  async put(key: string, data: Buffer) {
    const file = this.p(key);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
  }
  async get(key: string) {
    return fsp.readFile(this.p(key));
  }
  async stat(key: string) {
    try {
      const s = await fsp.stat(this.p(key));
      return { size: s.size };
    } catch {
      return null;
    }
  }
  createReadStream(key: string, range?: { start: number; end: number }) {
    return fs.createReadStream(this.p(key), range);
  }
  async signedUrl() {
    return null;
  }
  async delete(key: string) {
    await fsp.rm(this.p(key), { force: true });
  }
  async list(prefix: string) {
    const base = this.p(prefix.replace(/\/$/, "") || ".");
    const out: string[] = [];
    const walk = async (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else out.push(path.relative(this.root, full).split(path.sep).join("/"));
      }
    };
    await walk(base);
    return out;
  }
  async deletePrefix(prefix: string) {
    const keys = await this.list(prefix);
    await fsp.rm(this.p(prefix.replace(/\/$/, "")), { recursive: true, force: true });
    return keys.length;
  }
}

class OssStorage implements StorageDriver {
  readonly name = "oss" as const;
  private clientPromise: Promise<import("ali-oss")> | null = null;
  private async client() {
    if (!this.clientPromise) {
      this.clientPromise = import("ali-oss").then((m) => {
        const OSS = (m as unknown as { default: typeof import("ali-oss") }).default ?? m;
        const e = env();
        return new (OSS as unknown as new (o: object) => import("ali-oss"))({
          region: e.OSS_REGION,
          bucket: e.OSS_BUCKET,
          accessKeyId: e.OSS_ACCESS_KEY_ID,
          accessKeySecret: e.OSS_ACCESS_KEY_SECRET,
          endpoint: e.OSS_ENDPOINT || undefined,
          secure: true,
          timeout: 60_000,
        });
      });
    }
    return this.clientPromise;
  }
  async put(key: string, data: Buffer, contentType: string) {
    const c = await this.client();
    await c.put(safeKey(key), data, { headers: { "Content-Type": contentType, "x-oss-object-acl": "private" } });
  }
  async get(key: string) {
    const c = await this.client();
    const r = await c.get(safeKey(key));
    return r.content as Buffer;
  }
  async stat(key: string) {
    const c = await this.client();
    try {
      const r = await c.head(safeKey(key));
      const len = Number((r.res.headers as Record<string, string>)["content-length"] ?? 0);
      return { size: len };
    } catch {
      return null;
    }
  }
  createReadStream() {
    return null;
  }
  async signedUrl(key: string, expiresSec: number) {
    const c = await this.client();
    return c.signatureUrl(safeKey(key), { expires: expiresSec, method: "GET" });
  }
  async delete(key: string) {
    const c = await this.client();
    try {
      await c.delete(safeKey(key));
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e;
    }
  }
  async list(prefix: string) {
    const c = await this.client();
    const out: string[] = [];
    let marker: string | undefined;
    do {
      const r = await c.list({ prefix, marker, "max-keys": 1000 }, {});
      for (const o of r.objects ?? []) out.push(o.name);
      marker = r.isTruncated ? r.nextMarker : undefined;
    } while (marker);
    return out;
  }
  async deletePrefix(prefix: string) {
    const c = await this.client();
    const keys = await this.list(prefix);
    for (let i = 0; i < keys.length; i += 1000) {
      await c.deleteMulti(keys.slice(i, i + 1000), { quiet: true });
    }
    return keys.length;
  }
}

let driver: StorageDriver | null = null;

export function storage(): StorageDriver {
  if (driver) return driver;
  const e = env();
  if (e.STORAGE_DRIVER === "oss") {
    if (!e.OSS_BUCKET || !e.OSS_ACCESS_KEY_ID || !e.OSS_ACCESS_KEY_SECRET) {
      throw new Error("STORAGE_DRIVER=oss 但 OSS 配置不完整");
    }
    driver = new OssStorage();
  } else {
    driver = new LocalStorage(path.resolve(e.LOCAL_STORAGE_DIR));
  }
  return driver;
}

export function recordingKey(userId: string, sessionId: string, answerId: string, ext: string) {
  return `recordings/${userId}/${sessionId}/${answerId}.${ext}`;
}

export function ttsKey(hash: string, ext = "mp3") {
  return `tts/${hash}.${ext}`;
}
