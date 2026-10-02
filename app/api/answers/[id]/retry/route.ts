import { apiUser, handle, json } from "@/lib/auth-server";
import { retryProcessing } from "@/lib/services/answers";

export const dynamic = "force-dynamic";

/** 重试失败的处理（跳过已完成阶段） */
export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const u = await apiUser();
  const { id } = await ctx.params;
  return json(await retryProcessing(u.id, id));
});
