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
import { QUEUES, getBoss, stopBoss } from "@/lib/queue";
import { purgeSession, purgeUser } from "@/lib/services/deletion";
import { generateTtsAsset, pregenerateAll } from "@/lib/services/tts";
import { startWorkerHeartbeat } from "@/lib/worker-health";

async function main() {
  const e = env();
  console.log(`[worker] 启动：AI_PROVIDER=${e.AI_PROVIDER} STORAGE_DRIVER=${e.STORAGE_DRIVER}`);
  if (e.TIME_SCALE !== 1) {
    console.warn(`[worker] ⚠️ TIME_SCALE=${e.TIME_SCALE}（仅用于自动化测试，生产必须为 1）`);
  }
  const boss = await getBoss({ worker: true });

  await boss.work(
    QUEUES.processAnswer,
    { includeMetadata: true, localConcurrency: 3, batchSize: 1, pollingIntervalSeconds: 1 },
    async (jobs: JobWithMetadata<ProcessJob>[]) => {
      for (const job of jobs) {
        const finalAttempt = job.retryCount >= job.retryLimit;
        await processAnswer(job.data, { finalAttempt });
      }
    },
  );

  await boss.work<{ assetId: string; force?: boolean }>(
    QUEUES.tts,
    { localConcurrency: 2, batchSize: 1, pollingIntervalSeconds: 1 },
    async (jobs: Job<{ assetId: string; force?: boolean }>[]) => {
      for (const job of jobs) await generateTtsAsset(job.data.assetId, { force: job.data.force });
    },
  );

  await boss.work<{ versionIds?: string[] }>(QUEUES.ttsPregen, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await pregenerateAll({ versionIds: job.data?.versionIds });
  });

  await boss.work<{ sessionId: string }>(QUEUES.cleanupSession, { batchSize: 1, pollingIntervalSeconds: 2 }, async (jobs) => {
    for (const job of jobs) await purgeSession(job.data.sessionId);
  });

  await boss.work<{ userId: string }>(QUEUES.cleanupUser, { batchSize: 1, pollingIntervalSeconds: 2 }, async (jobs) => {
    for (const job of jobs) await purgeUser(job.data.userId);
  });

  await boss.work(QUEUES.hourly, { batchSize: 1 }, async () => {
    await hourlyMaintenance();
  });
  await boss.work(QUEUES.daily, { batchSize: 1 }, async () => {
    await dailyMaintenance();
  });

  // 定时任务（上海时区）：每小时整点标记放弃会话；每天 03:30 清理
  await boss.schedule(QUEUES.hourly, "0 * * * *", null, { tz: "Asia/Shanghai" });
  await boss.schedule(QUEUES.daily, "30 3 * * *", null, { tz: "Asia/Shanghai" });

  // 启动时补齐缺失的考官音频
  await pregenerateAll().catch((err) => console.error("[worker] 考官音频预生成失败", err));
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
