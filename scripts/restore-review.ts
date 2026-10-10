import "./_env";
import path from "node:path";
import { approveRestoreReview, prepareRestoreReview } from "@/lib/restore-review";

try {
  const databaseUrl = process.env.RESTORE_DATABASE_URL, directory = process.env.RESTORE_DATA_DIR, action = process.argv[2];
  if (!databaseUrl || !directory || !["prepare", "approve"].includes(action)) throw new Error("设置 RESTORE_DATABASE_URL / RESTORE_DATA_DIR 后运行 npm run restore:review -- prepare [最新账本文件] 或 approve [检查表文件]");
  if (new URL(databaseUrl).pathname === new URL(process.env.DATABASE_URL!).pathname) throw new Error("恢复检查目标不能是当前业务库");
  if (action === "prepare") {
    const result = await prepareRestoreReview(databaseUrl, path.resolve(directory), process.argv[3]);
    console.log(`检查表已生成：${result.file}。请逐一核对 ${result.accounts} 个账号、${result.costEntries} 项费用及部署配置；未开放服务。`);
  } else {
    const result = await approveRestoreReview(databaseUrl, path.resolve(directory), process.argv[3] || path.resolve(directory, "restore-review.json"));
    console.log(`恢复检查${result.alreadyApproved ? "已通过（重复操作未重复记费）" : "通过"}。私有临时凭据：${result.credentialsFile}。请私下交付本人，首次登录必须改密，个人 API Key 需重新填写。网页与 worker 未自动启动。`);
  }
} catch { console.error("恢复检查未通过：请检查目标与检查表、账号权限、费用下限、当前月份及服务是否已停止。未开放未通过检查的实例；详细要求见 docs/备份恢复与回滚.md。"); process.exitCode = 1; }
