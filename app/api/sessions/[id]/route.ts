import { apiUser, handle, json } from "@/lib/auth-server";
import { deleteSession } from "@/lib/services/deletion";
import { getSessionView } from "@/lib/services/sessions";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** 会话、题目计划（含考官音频编号）、计时状态、答题记录、服务器时间 */
export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const u = await apiUser();
  const { id } = await ctx.params;
  return json(await getSessionView(u.id, id));
});

/** 立即撤销访问，后台清理录音、转写和反馈 */
export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const u = await apiUser();
  const { id } = await ctx.params;
  return json(await deleteSession(u.id, id, u.id));
});
