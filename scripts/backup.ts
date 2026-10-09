import "./_env";
import { env } from "@/lib/env";
import { createBackup } from "@/lib/backup";

try {
  const config = env();
  const result = await createBackup({ databaseUrl: config.DATABASE_URL, dataDirectory: config.DATA_DIR,
    storageDirectory: config.LOCAL_STORAGE_DIR, backupDirectory: process.env.BACKUP_DIR || "data/backups", storageDriver: config.STORAGE_DRIVER });
  console.log(`完整备份完成：${result.directory}（${result.files} 个文件，${result.bytes} 字节）`);
} catch (error) { console.error("备份未完成：", (error as Error).message); process.exitCode = 1; }
