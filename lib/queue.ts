import { PgBoss } from "pg-boss";
import { env } from "@/lib/env";
import { taskRuntimeId, taskEnvelope, withTaskRuntime } from "@/lib/task-runtime";
import { checkedTaskPayload } from "@/lib/task-schema";

export const QUEUES = {
  processAnswer: "answer-process",
  tts: "tts-generate",
  ttsPregen: "tts-pregenerate",
  cleanupSession: "cleanup-session",
  cleanupUser: "cleanup-user",
  hourly: "maintenance-hourly",
  daily: "maintenance-daily",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
export function taskQueueName(name: QueueName) { return `speak-v1-${taskRuntimeId()}-${name}`; }

/** 失败自动重试最多 2 次（指数退避） */
const QUEUE_OPTIONS = { retryLimit: 2, retryDelay: 5, retryBackoff: true, retryDelayMax: 120, expireInSeconds: 600 };

const g = globalThis as unknown as { __boss?: Promise<PgBoss>; __bossWorker?: boolean };

async function createBoss(worker: boolean): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: env().DATABASE_URL,
    max: worker ? 6 : 2,
    // 维护与定时任务只在 worker 中运行
    supervise: worker,
    schedule: worker,
    migrate: true,
  });
  boss.on("error", (err) => console.error("[queue]", err instanceof Error ? err.message : err));
  await boss.start();
  for (const name of Object.values(QUEUES)) {
    await boss.createQueue(taskQueueName(name), QUEUE_OPTIONS);
  }
  return boss;
}

export function getBoss(opts: { worker?: boolean } = {}): Promise<PgBoss> {
  if (!g.__boss) {
    g.__bossWorker = !!opts.worker;
    g.__boss = withTaskRuntime(() => createBoss(!!opts.worker), !opts.worker).catch((e) => {
      g.__boss = undefined;
      throw e;
    });
  }
  return withTaskRuntime(async () => (await g.__boss)!, !opts.worker);
}

export async function enqueue(name: QueueName, data: object, options: { startAfter?: number; singletonKey?: string } = {}) {
  const boss = await getBoss();
  return withTaskRuntime(() => boss.send(taskQueueName(name), taskEnvelope(name, checkedTaskPayload(name, data)), options));
}

export async function stopBoss() {
  if (g.__boss) {
    const b = await g.__boss.catch(() => null);
    g.__boss = undefined;
    await b?.stop({ graceful: true, timeout: 10_000 }).catch(() => {});
  }
}
