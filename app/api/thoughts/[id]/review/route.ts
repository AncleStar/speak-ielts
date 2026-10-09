import { apiUser, handle, json, readJson } from "@/lib/auth-server";
import { assertOrigin } from "@/lib/request-origin";
import { badRequest } from "@/lib/errors";
import { enrollThought, recordThoughtPractice } from "@/lib/services/thoughts";
import { reviewActionSchema } from "@/lib/thoughts/schema";
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertOrigin(req); const u = await apiUser(); const { id } = await ctx.params;
  const parsed = reviewActionSchema.safeParse(await readJson(req)); if (!parsed.success) throw badRequest("复习参数错误。");
  const p = parsed.data;
  return json(p.action === "practice" ? await recordThoughtPractice(u.id, id, p) : await enrollThought(u.id, id, p.revision, p.action === "remove"));
});
