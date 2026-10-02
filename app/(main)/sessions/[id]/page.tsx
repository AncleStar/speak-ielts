import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SessionReport } from "@/components/report/session-report";
import { requireUser } from "@/lib/auth-server";
import { AppError } from "@/lib/errors";
import { getSessionReport } from "@/lib/services/reports";

export const metadata: Metadata = { title: "练习报告" };

export default async function SessionReportPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await requireUser();
  const { id } = await params;
  let report;
  try {
    report = await getSessionReport(u.id, id);
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
  // 经过 JSON 序列化，与接口轮询返回的数据形状一致
  return <SessionReport initial={JSON.parse(JSON.stringify(report))} />;
}
