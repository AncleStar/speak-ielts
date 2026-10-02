import { opsLog } from "@/db/schema";
import { db } from "@/lib/db";

/** 运行日志：记录错误类型、处理耗时和任务编号；不记录原始录音、完整回答文本或密钥。 */
export async function logOps(level: "info" | "warn" | "error", kind: string, ref: string | null, message: string, durationMs?: number) {
  const line = `[${kind}] ${ref ?? ""} ${message}${durationMs !== undefined ? ` (${durationMs}ms)` : ""}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else if (process.env.LOG_LEVEL === "debug") console.log(line);
  try {
    await db.insert(opsLog).values({ level, kind, ref, message: message.slice(0, 1000), durationMs });
  } catch {
    /* 日志写入失败不影响主流程 */
  }
}
