import { apiUser, handle, json } from "@/lib/auth-server";
import { getAnswerDetail } from "@/lib/services/answers";

export const dynamic = "force-dynamic";

/** 回答状态与反馈 */
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const u = await apiUser();
  const { id } = await ctx.params;
  const d = await getAnswerDetail(u, id);
  return json({ answer: d.answer, feedback: d.feedback, session: d.session });
});
