import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { getWorkerHealth } from "@/lib/worker-health";
import { assertRecoveryReady } from "@/lib/recovery-state";
import { ensureTaskRuntime } from "@/lib/task-runtime";
import { AppError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** 容器健康检查 */
export async function GET() {
  try {
    await assertRecoveryReady();
    await ensureTaskRuntime();
    await db.execute(sql`select 1`);
    const worker = await getWorkerHealth();
    return Response.json({ app: "ielts-speaking", ok: worker.ready, database: true, worker: worker.ready, workerState: worker.state, time: Date.now() }, { status: worker.ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AppError && error.code === "task_runtime_mismatch") return Response.json({ app: "ielts-speaking", ok: false, database: true, worker: false, workerState: "task_mismatch" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    return Response.json({ app: "ielts-speaking", ok: false, database: false, worker: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
