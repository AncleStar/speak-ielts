import "./_env";
import { exportRecoveryLedger } from "@/lib/restore-review";

try {
  const output = process.argv[2];
  if (!output || !process.env.DATABASE_URL) throw new Error("运行 npm run restore:ledger -- 私有输出文件；先停止源环境网页与 worker");
  const result = await exportRecoveryLedger(process.env.DATABASE_URL, output);
  console.log(`已只读导出 ${result.entries} 项费用合计。文件包含内部用户标识，请私密保存，不上传 GitHub。`);
} catch { console.error("费用导出未完成：请检查数据库、私有输出路径及是否已停止源环境服务。不会覆盖已有文件。 "); process.exitCode = 1; }
