import "./_env";
import path from "node:path";
import { env } from "@/lib/env";
import { restoreBackup } from "@/lib/backup";

try {
  const config = env(), bundle = process.argv[2];
  const databaseUrl = process.env.RESTORE_DATABASE_URL, dataDirectory = process.env.RESTORE_DATA_DIR;
  if (!bundle || !databaseUrl || !dataDirectory) throw new Error("用法：设置 RESTORE_DATABASE_URL 和 RESTORE_DATA_DIR，再运行 npm run restore -- 备份目录。恢复仅支持新空库与新数据目录。");
  const result = await restoreBackup({ bundle, databaseUrl, dataDirectory, currentDatabaseUrl: config.DATABASE_URL,
    currentDataDirectory: config.DATA_DIR, currentStorageDirectory: config.LOCAL_STORAGE_DIR,
    latestDeletionLog: process.env.RESTORE_LATEST_DELETION_LOG || path.join(config.DATA_DIR, "deletion-log.jsonl"), noLaterDeletions: process.env.RESTORE_NO_LATER_DELETIONS === "true" });
  console.log(`数据恢复完成：${result.directory}；合并 ${result.deletionEntries} 条删除记录。旧密码已停用，服务保持关闭；请运行 restore:review 核对账号、费用与部署配置后再开放。`);
} catch (error) { console.error("恢复未完成：", (error as Error).message); process.exitCode = 1; }
