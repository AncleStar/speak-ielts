import "./_env";
import { env } from "@/lib/env";
import { createBackup } from "@/lib/backup";
import { runBackupMaintenance } from "@/lib/backup-maintenance";

// The one-shot container finishes its current snapshot before a normal stop.
if (process.argv.includes("--maintenance")) for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => { console.error("正在完成当前备份后停止；超过容器停止期限时会保留中断锁供检查"); });

try {
  const config = env();
  const options = { databaseUrl: config.DATABASE_URL, dataDirectory: config.DATA_DIR, storageDirectory: config.LOCAL_STORAGE_DIR,
    backupDirectory: process.env.BACKUP_DIR || "data/backups", storageDriver: config.STORAGE_DRIVER, allowEmptyDatabase: process.argv.includes("--allow-empty-db") };
  const maintained = process.argv.includes("--maintenance")
    ? await runBackupMaintenance(options, Number(process.env.BACKUP_RETENTION_DAYS || "7")) : null;
  const result = maintained ?? await createBackup(options);
  console.log(`完整备份完成：${result.directory}（${result.files} 个文件，${result.bytes} 字节）`);
  if (maintained) console.log(`清理 ${maintained.retention.deleted.length} 份旧备份；保留 ${maintained.retention.skipped.length} 份待检查目录`);
} catch (error) { console.error("备份未完成：", (error as Error).message); process.exitCode = 1; }
