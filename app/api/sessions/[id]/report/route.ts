import { apiUser, handle, json } from "@/lib/auth-server";
import { getSessionReport } from "@/lib/services/reports";

export const dynamic = "force-dynamic";

/** 处理中、可重试、部分完成或完整报告 */
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const u = await apiUser();
  const { id } = await ctx.params;
  return json(await getSessionReport(u.id, id));
});
