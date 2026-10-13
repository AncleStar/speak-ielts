import { z } from "zod";
const id = z.string().min(1).max(100).regex(/^[\w-]+$/);
const shapes = {
  "answer-process": z.object({ answerId: id, mode: z.enum(["full", "correction"]).optional() }).strict(),
  "tts-generate": z.object({ assetId: id, force: z.boolean().optional() }).strict(),
  "tts-pregenerate": z.object({ versionIds: z.array(id).max(500).optional() }).strict(),
  "cleanup-session": z.object({ sessionId: id, logId: id.optional() }).strict(),
  "cleanup-user": z.object({ userId: id, logId: id.optional() }).strict(),
  "maintenance-hourly": z.object({}).strict(), "maintenance-daily": z.object({}).strict(),
};
export function checkedTaskPayload(queue: string, data: unknown) {
  const shape = shapes[queue as keyof typeof shapes]; if (!shape) throw new Error("未知任务类型，已拒绝执行。");
  const parsed = shape.safeParse(data); if (!parsed.success) throw new Error("任务内容不符合当前协议，已保留供核对。"); return parsed.data;
}
