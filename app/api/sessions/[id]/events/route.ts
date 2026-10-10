import { z } from "zod";
import { apiUser, handle, json, readJson } from "@/lib/auth-server";
import { badRequest } from "@/lib/errors";
import { recordEvent } from "@/lib/services/sessions";

export const dynamic = "force-dynamic";

const schema = z.object({
  eventId: z.string().min(8).max(100),
  type: z.enum(["start", "pause", "part_start", "position", "skip", "finish", "interrupt", "heartbeat"]),
  expectedVersion: z.number().int().min(0).optional(),
  startEventId: z.string().min(8).max(100).optional(),
  pendingUploads: z.array(z.object({ submissionId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/), planIndex: z.number().int().min(0), kind: z.enum(["main", "followup", "rounding"]), followUpId: z.string().max(60).nullish(), consentVersion: z.number().int().min(0) })).max(100).optional(),
  part: z.number().int().optional(),
  position: z.number().int().optional(),
  planIndex: z.number().int().optional(),
  reason: z.string().max(100).optional(),
});

/** 开始、部分开始、跳过、结束、中断等事件（带事件标识，可重复提交） */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const u = await apiUser();
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await readJson(req));
  if (!parsed.success) throw badRequest("事件参数错误");
  return json(await recordEvent(u.id, id, parsed.data));
});
