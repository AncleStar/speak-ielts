import { eq } from "drizzle-orm";
import { appSetting } from "@/db/schema";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";

export const RECOVERY_STATE_KEY = "recovery:opening-review";

/** The database gate survives a missing file or a cached connection. No public bypass. */
export async function assertRecoveryReady() {
  env();
  const [row] = await db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, RECOVERY_STATE_KEY));
  if (row && (row.value as { status?: string }).status !== "approved")
    throw new AppError(503, "restore_review_required", "资料恢复检查尚未完成，暂时无法登录或训练，请等待部署者完成检查。");
}
