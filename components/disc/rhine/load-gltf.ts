import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { disposeThreeTree } from "./three-resources";

/** Each scene owns its request; leaving it must not abort another scene's asset. */
export async function loadGltf(url: string, signal: AbortSignal): Promise<GLTF> {
  signal.throwIfAborted();
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("训练磁盘模型暂时无法载入");
  const bytes = await response.arrayBuffer();
  signal.throwIfAborted();
  const gltf = await new GLTFLoader().parseAsync(bytes, url.slice(0, url.lastIndexOf("/") + 1));
  if (signal.aborted) {
    disposeThreeTree(gltf.scene);
    signal.throwIfAborted();
  }
  return gltf;
}
