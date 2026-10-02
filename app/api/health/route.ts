import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { getWorkerHealth } from "@/lib/worker-health";

export const dynamic = "force-dynamic";

/** 容器健康检查 */
export async function GET() {
  try {
    await db.execute(sql`select 1`);
    const worker = await getWorkerHealth();
    return Response.json({ app: "ielts-speaking", ok: worker.ready, database: true, worker: worker.ready, time: Date.now() }, { status: worker.ready ? 200 : 503 });
  } catch {
    return Response.json({ app: "ielts-speaking", ok: false, database: false, worker: false }, { status: 503 });
  }
}
