import { z } from "zod";
import { apiUser, handle, json, readJson } from "@/lib/auth-server";
import { badRequest } from "@/lib/errors";
import { submitCorrection } from "@/lib/services/answers";

export const dynamic = "force-dynamic";

/** 提交修正文本；可选择用修正文本重新生成反馈（原始转写保留） */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const u = await apiUser();
  const { id } = await ctx.params;
  const parsed = z.object({ text: z.string(), regenerate: z.boolean().default(true) }).safeParse(await readJson(req));
  if (!parsed.success) throw badRequest("参数错误");
  return json(await submitCorrection(u.id, id, parsed.data.text, parsed.data.regenerate));
});
