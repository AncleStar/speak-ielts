import type { Metadata } from "next";
import { SettingsForms } from "@/components/account/settings-forms";
import { PageHeader } from "@/components/page-header";
import { requireUser } from "@/lib/auth-server";
import { isMockProvider } from "@/lib/env";
import { getQuotaStatus } from "@/lib/quota";
import { AppearanceSettings } from "@/components/appearance";
import Link from "next/link";
import { getAiConfig } from "@/lib/ai/credentials";

export const metadata: Metadata = { title: "设置" };

export default async function SettingsPage() {
  const u = await requireUser();
  const quota = await getQuotaStatus(u.id);
  const personal = (await getAiConfig(u.id))?.mode === "personal";
  return (
    <>
      <PageHeader title="设置" description={`${u.name} · ${u.email}`} />
      <Link href="/settings/ai" className="ai-settings-entry"><span><small>API / USAGE</small><strong>API Key、模型与用量</strong><span>填写自己的密钥，选择模型，查看调用和费用明细。</span></span><span>打开 →</span></Link>
      <div className="mb-5 flex gap-5 text-sm text-brand-700"><Link href="/rewards" className="underline">积分与兑换</Link><Link href="/history" className="underline">学习记录</Link><Link href="/growth" className="underline">成长日历</Link></div>
      <AppearanceSettings />
      <SettingsForms
        mock={!personal && isMockProvider()}
        isAdmin={u.isAdmin}
        email={u.email}
        defaults={{
          targetBand: u.targetBand ?? "6.5",
          subtitlePref: u.subtitlePref,
          allowAdminView: u.allowAdminView,
        }}
        consentAt={u.consentAt?.toISOString() ?? null}
        dailyMinutes={Math.round(quota.limitSeconds / 60)}
      />
    </>
  );
}
