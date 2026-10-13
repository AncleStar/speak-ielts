import "./_env";
import { closeDb } from "@/lib/db";
import { taskRuntimeRecord, taskRuntimeStatus, activateTaskRuntime } from "@/lib/task-runtime";
import { recoverLegacyTasks } from "@/lib/task-recovery";
import { stopBoss } from "@/lib/queue";
try {
  if (process.argv.includes("--activate")) {
    if (!process.argv.includes("--confirm-stopped")) throw new Error("请先暂停新会话、停止旧后台，确认存储、模型及费用后加 --confirm-stopped。");
    const previous = await taskRuntimeRecord(); await activateTaskRuntime(previous?.id ?? null); console.log("当前任务环境已明确启用；旧队列和费用记录保留，未自动重放。");
  } else if (process.argv.includes("--recover-legacy")) {
    const result = await recoverLegacyTasks(process.argv.includes("--confirm-stopped")); console.log(JSON.stringify(result));
    if (result.retained) console.log("仍有未迁移任务，需按原记录核对；未自动删除、退款或重试失败的调用。");
  } else {
    const status = await taskRuntimeStatus(); console.log(status.matches ? "任务环境匹配。" : status.registered ? "任务环境不匹配，需先暂停并核对后明确启用。" : "尚未登记任务环境；迁移完成并启动网页后首次登记。");
  }
} catch { console.error("任务环境操作未完成。请确认已暂停新会话、停止旧后台并核对配置；原任务与费用保留。不会输出密钥或原始错误。"); process.exitCode = 1; }
finally { await stopBoss(); await closeDb(); }
