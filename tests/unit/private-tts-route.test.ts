import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  asset: { id: "test-audio", text: "test", model: "test-model", voice: "test-voice", isPrivate: true, answerId: "test-answer", status: "ready", storageKey: "test.mp3", mimeType: "audio/mpeg" },
  signedUrl: vi.fn(), get: vi.fn(),
}));
vi.mock("@/lib/auth-server", () => ({ apiUser: async () => ({ id: "owner", isAdmin: false }), handle: (fn: unknown) => fn }));
vi.mock("@/lib/services/tts", () => ({ getTtsAssetForViewer: async () => state.asset, ensureTtsAssets: vi.fn(), generateTtsAsset: vi.fn() }));
vi.mock("@/lib/providers", () => ({ providers: () => ({ ttsIdentity: () => ({ model: "test-model", voice: "test-voice" }) }) }));
vi.mock("@/lib/storage", () => ({ storage: () => ({ signedUrl: state.signedUrl, get: state.get }) }));
import { GET } from "@/app/api/tts/[id]/route";
beforeEach(() => { state.asset.isPrivate = true; state.signedUrl.mockReset().mockResolvedValue("https://objects.example.test/signed-audio"); state.get.mockReset().mockResolvedValue(Buffer.from("owned-audio-bytes")); });
it("proxies private reference speech instead of issuing a shareable object-store bearer URL", async () => {
  const response = await GET(new Request("http://localhost/api/tts/test-audio"), { params: Promise.resolve({ id: "test-audio" }) });
  expect(response.status).toBe(200); expect(response.headers.get("Location")).toBeNull(); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.text()).toBe("owned-audio-bytes"); expect(state.signedUrl).not.toHaveBeenCalled(); expect(state.get).toHaveBeenCalledWith("test.mp3");
});
it("retains object-store redirect delivery for shared examiner speech", async () => {
  state.asset.isPrivate = false;
  const response = await GET(new Request("http://localhost/api/tts/test-audio"), { params: Promise.resolve({ id: "test-audio" }) });
  expect(response.status).toBe(302); expect(response.headers.get("Location")).toBe("https://objects.example.test/signed-audio");
  expect(state.get).not.toHaveBeenCalled(); expect(state.signedUrl).toHaveBeenCalledWith("test.mp3", 600);
});
