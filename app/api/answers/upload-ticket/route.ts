import { z } from "zod";
import { apiUser, handle, json, readJson } from "@/lib/auth-server";
import { badRequest } from "@/lib/errors";
import { createUploadTicket } from "@/lib/services/answers";

export const dynamic = "force-dynamic";

const schema = z.object({
  sessionId: z.string().min(1).max(60),
  planIndex: z.number().int().min(0),
  kind: z.enum(["main", "followup", "rounding"]),
  followUpId: z.string().max(60).nullish(),
  submissionId: z.string().min(8).max(80),
  clientDurationMs: z.number().min(0).max(30 * 60 * 1000),
  interrupted: z.boolean().optional(),
  consentVersion: z.number().int().min(0).optional(),
});

/** 校验会话归属，按提交标识创建或复用回答，签发限定对象和有效期的上传凭证 */
export const POST = handle(async (req: Request) => {
  const u = await apiUser();
  const parsed = schema.safeParse(await readJson(req));
  if (!parsed.success) throw badRequest("参数错误");
  const r = await createUploadTicket(u.id, parsed.data);
  return json({ ...r, uploadUrl: `/api/answers/${r.answerId}/audio?ticket=${encodeURIComponent(r.ticket)}` });
});
