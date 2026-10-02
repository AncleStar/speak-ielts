import { z } from "zod";
import { apiUser, handle, json, readJson } from "@/lib/auth-server";
import { badRequest } from "@/lib/errors";
import { selectFollowUp } from "@/lib/services/sessions";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** 第五章：返回本次应问的追问（等待转写最长 12 秒，失败时使用默认追问） */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const u = await apiUser();
  const { id } = await ctx.params;
  const parsed = z.object({ planIndex: z.number().int().min(0) }).safeParse(await readJson(req));
  if (!parsed.success) throw badRequest("参数错误");
  return json(await selectFollowUp(u.id, id, parsed.data.planIndex));
});
