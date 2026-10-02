import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { DeviceCheck } from "@/components/device-check";
import { getPhrases } from "@/lib/content/load";
import { ensureTtsAssets } from "@/lib/services/tts";
import { providers } from "@/lib/providers";

export const metadata: Metadata = { title: "设备检查" };

export default async function DeviceCheckPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const text = getPhrases().device_check;
  const ids = await ensureTtsAssets([text]);
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : null;
  return (
    <>
      <PageHeader title="设备检查" description="检查麦克风权限、选择设备、录制并回放 5 秒试音，并试听考官声音。" />
      <DeviceCheck sampleTtsId={ids.get(text) ?? null} next={safeNext} voiceLabel={providers().ttsIdentity().label ?? providers().ttsIdentity().voice} />
    </>
  );
}
