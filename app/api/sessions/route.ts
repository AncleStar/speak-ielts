import { z } from "zod";
import { apiUser, handle, json, readJson } from "@/lib/auth-server";
import { badRequest } from "@/lib/errors";
import { createSession, listSessions } from "@/lib/services/sessions";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  mode: z.enum(["level", "mock", "practice", "retry"]),
  levelId: z.string().max(10).optional(),
  mockSetId: z.string().max(20).optional(),
  questionId: z.string().max(40).optional(),
  sourceAnswerId: z.string().max(60).optional(),
  fresh: z.boolean().optional(),
});

/** 检查额度，创建训练 / 模考 / 自由练习 / 重练会话，固定题目版本 */
export const POST = handle(async (req: Request) => {
  const u = await apiUser();
  const parsed = bodySchema.safeParse(await readJson(req));
  if (!parsed.success) throw badRequest("参数错误");
  const r = await createSession(u, parsed.data);
  return json(r, { status: r.reused ? 200 : 201 });
});

export const GET = handle(async (req: Request) => {
  const u = await apiUser();
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? undefined;
  const offset = Number(url.searchParams.get("offset") ?? 0) || 0;
  return json({ sessions: await listSessions(u.id, { mode, offset, limit: 30 }) });
});
