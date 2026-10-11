import http from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { loadGltf } from "@/components/disc/rhine/load-gltf";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function emptyGlb() {
  const json = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [] }] }).padEnd(84, " "));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32); json.copy(padded);
  const glb = Buffer.alloc(20 + padded.length); glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8); glb.writeUInt32LE(padded.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); padded.copy(glb, 20); return glb;
}
it("aborting a native HTTP asset fetch leaves another scene's identical URL request usable", async () => {
  let requests = 0, closed!: () => void, opened!: () => void;
  const disconnected = new Promise<void>(r => { closed = r; }), firstStarted = new Promise<void>(r => { opened = r; });
  const server = http.createServer((_, response) => {
    requests++; response.writeHead(200, { "Content-Type": "model/gltf-binary" });
    if (requests === 1) { response.flushHeaders(); response.once("close", closed); opened(); } else response.end(emptyGlb());
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number }, url = `http://127.0.0.1:${address.port}/disc.glb`, controller = new AbortController();
  try {
    const first = loadGltf(url, controller.signal); const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await firstStarted; const peer = await loadGltf(url, new AbortController().signal); expect(peer.scene).toBeInstanceOf(THREE.Group);
    controller.abort(); await rejected; await disconnected; expect(requests).toBe(2);
  } finally { controller.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
it("a decoder completing after cancellation releases its returned geometry, materials and textures", async () => {
  let started!: () => void, release!: (value: GLTF) => void;
  const parsing = new Promise<void>(resolve => { started = resolve; });
  const decoded = new Promise<GLTF>(resolve => { release = resolve; });
  vi.stubGlobal("fetch", async () => new Response(emptyGlb()));
  vi.spyOn(GLTFLoader.prototype, "parseAsync").mockImplementation(() => { started(); return decoded; });
  const scene = new THREE.Group(), geometry = new THREE.BoxGeometry(), texture = new THREE.Texture(), material = new THREE.MeshBasicMaterial({ map: texture }); scene.add(new THREE.Mesh(geometry, material));
  const geometryDisposed = vi.fn(), materialDisposed = vi.fn(), textureDisposed = vi.fn(); geometry.addEventListener("dispose", geometryDisposed); material.addEventListener("dispose", materialDisposed); texture.addEventListener("dispose", textureDisposed);
  const controller = new AbortController(), loading = loadGltf("/disc.glb", controller.signal), rejected = expect(loading).rejects.toMatchObject({ name: "AbortError" });
  await parsing; controller.abort(); release({ scene } as GLTF); await rejected;
  expect(geometryDisposed).toHaveBeenCalledOnce(); expect(materialDisposed).toHaveBeenCalledOnce(); expect(textureDisposed).toHaveBeenCalledOnce(); expect(scene.children).toHaveLength(0);
});
