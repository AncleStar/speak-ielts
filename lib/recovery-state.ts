import { eq, sql } from "drizzle-orm";
import { appSetting } from "@/db/schema";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { RECOVERY_STATE_KEY, RESTORE_PENDING_SCHEMA } from "@/lib/recovery-constants";

export { RECOVERY_STATE_KEY } from "@/lib/recovery-constants";

/** The database gate survives a missing file or a cached connection. No public bypass. */
export async function assertRecoveryReady() {
  env();
  // Check before app_setting exists, and independently of restored or missing markers.
  const guard = await db.execute<{ pending: boolean }>(sql`SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=${RESTORE_PENDING_SCHEMA}) AS pending`);
  if (guard.rows[0]?.pending)
    throw new AppError(503, "restore_review_required", "资料恢复检查尚未完成，暂时无法登录或训练，请等待部署者完成检查。");
  const [row] = await db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, RECOVERY_STATE_KEY));
  if (row && (row.value as { status?: string }).status !== "approved")
    throw new AppError(503, "restore_review_required", "资料恢复检查尚未完成，暂时无法登录或训练，请等待部署者完成检查。");
}
