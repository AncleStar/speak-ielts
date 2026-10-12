import "./_env";
import { setTimeout as delay } from "node:timers/promises";
import { env } from "@/lib/env";
import { checkpointDeletionLog, runBackupMaintenance } from "@/lib/backup-maintenance";

const config = env(), backupDirectory = process.env.BACKUP_DIR || "data/backups";
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS || "7");
if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365 || config.STORAGE_DRIVER !== "local") throw new Error("备份循环需要本地存储和有效保留天数");
const options = { databaseUrl: config.DATABASE_URL, dataDirectory: config.DATA_DIR, storageDirectory: config.LOCAL_STORAGE_DIR, backupDirectory, storageDriver: config.STORAGE_DRIVER };
let nextBackup = 0;
let stopping = false;
const interrupt = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { stopping = true; interrupt.abort(); });
while (!stopping) {
  try {
    if (performance.now() >= nextBackup) {
      const saved = await runBackupMaintenance(options, retentionDays);
      console.log(`完整备份完成（${saved.files} 个文件）；清理 ${saved.retention.deleted.length} 份旧备份，保留 ${saved.retention.skipped.length} 份待检查目录`);
      nextBackup = performance.now() + 86_400_000;
    } else await checkpointDeletionLog(backupDirectory, config.DATA_DIR);
  } catch { console.error("备份或删除检查点未完成，保留已有资料，一分钟后重试；请检查日志格式、维护锁、连接、权限及空间"); }
  if (!stopping) await delay(60_000, undefined, { signal: interrupt.signal }).catch(error => { if (!interrupt.signal.aborted) throw error; });
}
