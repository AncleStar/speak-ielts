/**
 * 后台 worker（独立 Node.js 进程 + pg-boss）：
 * 回答处理（转码、转写、反馈）、考官音频生成、删除清理、定时维护。
 */
import "../scripts/_env";
import type { Job, JobWithMetadata } from "pg-boss";
import { closeDb } from "@/lib/db";
import { env } from "@/lib/env";
import { processAnswer, type ProcessJob } from "@/lib/jobs/process-answer";
import { dailyMaintenance, hourlyMaintenance } from "@/lib/jobs/maintenance";
import { logOps } from "@/lib/ops";
import { QUEUES, getBoss, stopBoss, taskQueueName } from "@/lib/queue";
import { taskRuntimeStatus, withTaskRuntime, taskPayload, taskEnvelope, type TaskEnvelope } from "@/lib/task-runtime";
import { purgeSession, purgeUser } from "@/lib/services/deletion";
import { generateTtsAsset, pregenerateAll } from "@/lib/services/tts";
import { startWorkerHeartbeat } from "@/lib/worker-health";
import { assertRecoveryReady } from "@/lib/recovery-state";

async function main() {
  const e = env();
  await assertRecoveryReady();
  console.log(`[worker] 启动：AI_PROVIDER=${e.AI_PROVIDER} STORAGE_DRIVER=${e.STORAGE_DRIVER}`);
  if (e.TIME_SCALE !== 1) {
    console.warn(`[worker] ⚠️ TIME_SCALE=${e.TIME_SCALE}（仅用于自动化测试，生产必须为 1）`);
  }
  const deadline = Date.now() + 60000;
  for (;;) {
    const runtime = await taskRuntimeStatus();
    if (runtime.matches) break;
    if (runtime.registered || Date.now() >= deadline) throw new Error("任务运行环境未匹配；请先启动当前网页或完成运行环境核对。未领取任何任务。");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const boss = await getBoss({ worker: true });

  await boss.work(
    taskQueueName(QUEUES.processAnswer),
    { includeMetadata: true, localConcurrency: 3, batchSize: 1, pollingIntervalSeconds: 1 },
    async (jobs: JobWithMetadata<TaskEnvelope<ProcessJob>>[]) => {
      for (const job of jobs) {
        const finalAttempt = job.retryCount >= job.retryLimit;
        await withTaskRuntime(() => processAnswer(taskPayload(QUEUES.processAnswer, job.data), { finalAttempt }), false);
      }
    },
  );

  await boss.work<TaskEnvelope<{ assetId: string; force?: boolean }>>(
    taskQueueName(QUEUES.tts),
    { localConcurrency: 2, batchSize: 1, pollingIntervalSeconds: 1 },
    async (jobs: Job<TaskEnvelope<{ assetId: string; force?: boolean }>>[]) => {
      for (const job of jobs) await withTaskRuntime(async () => { const data = taskPayload(QUEUES.tts, job.data); await generateTtsAsset(data.assetId, { force: data.force }); }, false);
    },
  );

  await boss.work<TaskEnvelope<{ versionIds?: string[] }>>(taskQueueName(QUEUES.ttsPregen), { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await withTaskRuntime(async () => { const data = taskPayload(QUEUES.ttsPregen, job.data); await pregenerateAll({ versionIds: data.versionIds }); }, false);
  });

  await boss.work<TaskEnvelope<{ sessionId: string }>>(taskQueueName(QUEUES.cleanupSession), { batchSize: 1, pollingIntervalSeconds: 2 }, async (jobs) => {
    for (const job of jobs) await withTaskRuntime(() => purgeSession(taskPayload(QUEUES.cleanupSession, job.data).sessionId), false);
  });

  await boss.work<TaskEnvelope<{ userId: string }>>(taskQueueName(QUEUES.cleanupUser), { batchSize: 1, pollingIntervalSeconds: 2 }, async (jobs) => {
    for (const job of jobs) await withTaskRuntime(() => purgeUser(taskPayload(QUEUES.cleanupUser, job.data).userId), false);
  });

  await boss.work<TaskEnvelope>(taskQueueName(QUEUES.hourly), { batchSize: 1 }, async jobs => {
    for (const job of jobs) await withTaskRuntime(async () => { taskPayload(QUEUES.hourly, job.data); await hourlyMaintenance(); }, false);
  });
  await boss.work<TaskEnvelope>(taskQueueName(QUEUES.daily), { batchSize: 1 }, async jobs => {
    for (const job of jobs) await withTaskRuntime(async () => { taskPayload(QUEUES.daily, job.data); await dailyMaintenance(); }, false);
  });

  // 定时任务（上海时区）：每小时整点标记放弃会话；每天 03:30 清理
  await withTaskRuntime(async () => {
    await boss.schedule(taskQueueName(QUEUES.hourly), "0 * * * *", taskEnvelope(QUEUES.hourly, {}), { tz: "Asia/Shanghai" });
    await boss.schedule(taskQueueName(QUEUES.daily), "30 3 * * *", taskEnvelope(QUEUES.daily, {}), { tz: "Asia/Shanghai" });
  }, false);

  // 启动时补齐缺失的考官音频
  await withTaskRuntime(() => pregenerateAll(), false).catch(() => console.error("[worker] 考官音频预生成失败，请检查当前环境。"));
  await logOps("info", "worker", null, "worker 已启动");
  const stopHeartbeat = await startWorkerHeartbeat();
  console.log("[worker] 就绪");

  const shutdown = async () => {
    console.log("[worker] 正在停止…");
    await stopHeartbeat().catch(() => {});
    await stopBoss();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[worker] 启动失败", e);
  process.exit(1);
});
