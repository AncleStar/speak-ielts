import { apiUser, handle, json } from "@/lib/auth-server";
import { submitAnswer } from "@/lib/services/answers";

export const dynamic = "force-dynamic";

/** 确认录音已保存，创建处理任务（同一回答只创建一次） */
export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const u = await apiUser();
  const { id } = await ctx.params;
  return json(await submitAnswer(u.id, id));
});
