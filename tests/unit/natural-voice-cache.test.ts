import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ensureNaturalVoiceCache, voiceCacheDirectory, type VoiceProgress } from "@/lib/providers/natural-voice-cache";

const base = path.resolve("data/verification"), root = path.join(base, `voice-cache-${randomUUID()}`), body = Buffer.from("synthetic-model-fixture".repeat(100));
const entry = { file: "onnx/model_quantized.onnx", bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") };
let server: http.Server, origin = "", requests = 0;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests++;
    if (req.url === "/headers-stall") return;
    res.setHeader("Content-Type", "application/octet-stream");
    if (req.url === "/compressed") { const compressed = gzipSync(body); res.setHeader("Content-Encoding", "gzip"); res.setHeader("Content-Length", compressed.length); res.end(compressed); return; }
    if (req.url === "/body-stall") { res.write(body.subarray(0, 5)); return; }
    if (req.url === "/truncated") { res.end(body.subarray(0, 5)); return; }
    if (req.url === "/too-large") { res.end(Buffer.concat([body, body])); return; }
    if (req.url === "/same-size-wrong") { res.end(Buffer.alloc(body.length, 1)); return; }
    if (req.url === "/slow") { res.write(body.subarray(0, 5)); setTimeout(() => res.end(body.subarray(5)), 75); return; }
    res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); if (!root.startsWith(base + path.sep)) throw new Error("Unsafe fixture cleanup"); await fs.rm(root, { recursive: true, force: true }); });
const options = (route: string) => ({ files: [entry], allowDownload: true, fetchFile: (_file: string, signal: AbortSignal) => fetch(`${origin}${route}`, { signal }), idleTimeoutMs: 250, connectionTimeoutMs: 250, timeoutMs: 3000 });
const directory = (name: string) => path.join(root, name), finalFile = (name: string) => path.join(voiceCacheDirectory(directory(name)), entry.file);
async function leftoverParts(name: string) { return (await fs.readdir(path.dirname(finalFile(name))).catch(() => [])).filter(file => file.endsWith(".part")); }

it("publishes only verified files atomically, reports progress and reuses offline cache without dispatch", async () => {
  const events: VoiceProgress[] = []; await ensureNaturalVoiceCache(directory("valid"), { ...options("/ok"), onProgress: event => events.push(event) });
  expect(await fs.readFile(finalFile("valid"))).toEqual(body); expect(events.some(event => event.stage === "download" && event.loaded === body.length)).toBe(true);
  expect(events.at(-1)?.stage).toBe("verified"); expect(await leftoverParts("valid")).toEqual([]);
  const before = requests; await ensureNaturalVoiceCache(directory("valid"), { files: [entry] }); expect(requests).toBe(before);
});
it("rejects missing or corrupted cache offline and repairs zero-length cache only with explicit preparation", async () => {
  await fs.mkdir(path.dirname(finalFile("broken")), { recursive: true }); await fs.writeFile(finalFile("broken"), "");
  const before = requests; await expect(ensureNaturalVoiceCache(directory("broken"), { files: [entry] })).rejects.toMatchObject({ code: "missing" }); expect(requests).toBe(before);
  await ensureNaturalVoiceCache(directory("broken"), options("/ok")); expect(await fs.readFile(finalFile("broken"))).toEqual(body);
});
it("refuses truncated, same-size corrupt and oversized downloads and preserves other verified files", async () => {
  for (const name of ["truncated", "same-size-wrong", "too-large"]) {
    await expect(ensureNaturalVoiceCache(directory(name), options(`/${name}`))).rejects.toMatchObject({ code: "integrity" });
    expect(await fs.stat(finalFile(name)).catch(() => null)).toBeNull(); expect(await leftoverParts(name)).toEqual([]);
  }
  expect(await fs.readFile(finalFile("valid"))).toEqual(body);
});
it("bounds connection and idle stalls, retries once, cleans its partial files and can be retried normally", async () => {
  for (const route of ["headers-stall", "body-stall"]) {
    const before = requests;
    await expect(ensureNaturalVoiceCache(directory(route), { ...options(`/${route}`), connectionTimeoutMs: 50, idleTimeoutMs: 50 })).rejects.toMatchObject({ code: "timeout" });
    expect(requests - before).toBe(2); expect(await leftoverParts(route)).toEqual([]);
    await ensureNaturalVoiceCache(directory(route), options("/ok")); expect(await fs.readFile(finalFile(route))).toEqual(body);
  }
});
it("cancellation and the overall deadline abort the real HTTP stream without retrying or publishing partial files", async () => {
  const cancellation = new AbortController(), before = requests;
  const pending = ensureNaturalVoiceCache(directory("cancelled"), { ...options("/body-stall"), signal: cancellation.signal, onProgress: event => { if (event.loaded > 0) cancellation.abort(); } });
  await expect(pending).rejects.toMatchObject({ code: "cancelled" }); expect(requests - before).toBe(1); expect(await leftoverParts("cancelled")).toEqual([]);
  await expect(ensureNaturalVoiceCache(directory("deadline"), { ...options("/body-stall"), timeoutMs: 50 })).rejects.toMatchObject({ code: "timeout" }); expect(await leftoverParts("deadline")).toEqual([]);
});
it("concurrent preparations never expose a partial final file or remove another attempt's temporary file", async () => {
  const first = ensureNaturalVoiceCache(directory("concurrent"), options("/slow")), second = ensureNaturalVoiceCache(directory("concurrent"), options("/slow"));
  await new Promise(resolve => setTimeout(resolve, 25)); expect(await fs.stat(finalFile("concurrent")).catch(() => null)).toBeNull();
  await Promise.all([first, second]); expect(await fs.readFile(finalFile("concurrent"))).toEqual(body); expect(await leftoverParts("concurrent")).toEqual([]);
});
it("rejects symlink cache directories and path escape before writing or sending a request", async () => {
  const outside = path.join(root, "outside"), linked = directory("symlink"); await fs.mkdir(outside, { recursive: true });
  await fs.symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
  const before = requests; await expect(ensureNaturalVoiceCache(linked, options("/ok"))).rejects.toMatchObject({ code: "unsafe" });
  await expect(ensureNaturalVoiceCache(directory("escape"), { ...options("/ok"), files: [{ ...entry, file: "../../escaped" }] })).rejects.toMatchObject({ code: "unsafe" });
  expect(requests).toBe(before); expect(await fs.readdir(outside)).toEqual([]);
});
it("checks decompressed response bytes rather than trusting the compressed Content-Length", async () => {
  await ensureNaturalVoiceCache(directory("compressed"), options("/compressed")); expect(await fs.readFile(finalFile("compressed"))).toEqual(body);
});
it("a disk write failure stops without downloading again or replacing a valid cache file", async () => {
  const before = requests, open = vi.spyOn(fs, "open").mockRejectedValueOnce(Object.assign(new Error("synthetic disk full"), { code: "ENOSPC" }));
  try { await expect(ensureNaturalVoiceCache(directory("full"), options("/ok"))).rejects.toMatchObject({ code: "storage" }); }
  finally { open.mockRestore(); }
  expect(requests - before).toBe(1); expect(await leftoverParts("full")).toEqual([]); expect(await fs.readFile(finalFile("valid"))).toEqual(body);
});
