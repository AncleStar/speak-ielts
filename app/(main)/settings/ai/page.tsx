import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth-server";
import { getAiAccount } from "@/lib/ai/account";
import { ApiSettings } from "@/components/account/api-settings";
import { PageHeader } from "@/components/page-header";
export const metadata: Metadata = { title: "API 与用量" };
export default async function AiSettingsPage() {
  const u = await requireUser();
  return <><PageHeader title="API 与用量" description="选择你的模型，查看每次练习的服务用量。" actions={<Link href="/settings" className="text-sm underline">返回设置</Link>}/><ApiSettings initial={await getAiAccount(u.id)}/></>;
}
