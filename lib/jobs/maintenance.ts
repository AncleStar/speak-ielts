import { and, inArray, lt } from "drizzle-orm";
import { answer } from "@/db/schema";
import { db } from "@/lib/db";
import { logOps } from "@/lib/ops";
import { QUEUES, enqueue } from "@/lib/queue";
import { dailyCleanup } from "@/lib/services/deletion";
import { abandonStaleSessions } from "@/lib/services/sessions";
import { getSettings } from "@/lib/settings";

/** 每小时：标记无活动会话为"已放弃"并释放额度；重新排队卡住的回答 */
export async function hourlyMaintenance() {
  const settings = await getSettings();
  const abandoned = await abandonStaleSessions(settings.limits.abandonMinutes);
  const stuckBefore = new Date(Date.now() - 15 * 60_000);
  const stuck = await db
    .select({ id: answer.id })
    .from(answer)
    .where(and(inArray(answer.status, ["queued", "processing"]), lt(answer.updatedAt, stuckBefore)));
  for (const a of stuck) await enqueue(QUEUES.processAnswer, { answerId: a.id, mode: "full" });
  const result = { abandoned, requeued: stuck.length };
  await logOps("info", "maintenance", null, `每小时维护：${JSON.stringify(result)}`);
  return result;
}

export async function dailyMaintenance() {
  return dailyCleanup();
}
