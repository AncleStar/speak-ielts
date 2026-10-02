import { z } from "zod";
import { apiUser, handle, json, readJson } from "@/lib/auth-server";
import { badRequest } from "@/lib/errors";
import { addRetryItem, removeRetryItem } from "@/lib/services/answers";

export const dynamic = "force-dynamic";

/** 加入重练：把题目放入待重练清单（首页"今日建议"优先展示） */
export const POST = handle(async (req: Request) => {
  const u = await apiUser();
  const parsed = z.object({ answerId: z.string().min(1).max(60), note: z.string().max(200).optional() }).safeParse(await readJson(req));
  if (!parsed.success) throw badRequest("参数错误");
  return json(await addRetryItem(u.id, parsed.data.answerId, parsed.data.note));
});

export const DELETE = handle(async (req: Request) => {
  const u = await apiUser();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) throw badRequest("缺少编号");
  await removeRetryItem(u.id, id);
  return json({ ok: true });
});
