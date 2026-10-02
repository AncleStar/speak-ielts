/**
 * 种子脚本：导入题库、关卡、模考与默认设置，创建首个管理员。
 * - SEED_PUBLISH_DRAFTS=true 时直接发布 AI 草稿（仅开发/模拟试用；界面标记"AI 草稿·未人工审核"）
 * - CONTENT_REQUIRE_REVIEW=true 时只发布审核通过（approved）的题目
 * 用法：npm run db:seed [-- --no-tts]
 */
import "./_env";
import path from "node:path";
import { eq } from "drizzle-orm";
import { user } from "@/db/schema";
import { createAccount } from "@/lib/auth";
import { loadContent } from "@/lib/content/load";
import { checkIntegrity } from "@/lib/content/validate";
import { closeDb, db } from "@/lib/db";
import { env } from "@/lib/env";
import { QUEUES, enqueue, stopBoss } from "@/lib/queue";
import { syncLevelsAndMocks, upsertQuestions } from "@/lib/services/content";
import { ensureDefaultSettings } from "@/lib/settings";

export async function seed(opts: { tts?: boolean; quiet?: boolean } = {}) {
  const log = opts.quiet ? () => {} : console.log;
  const e = env();
  const bundle = loadContent(undefined, { fresh: true });
  const report = checkIntegrity(bundle);
  if (!report.ok) throw new Error(`题库完整性检查失败：\n${report.errors.join("\n")}`);

  const autoPublish = e.SEED_PUBLISH_DRAFTS;
  if (autoPublish && e.CONTENT_REQUIRE_REVIEW) {
    log("⚠️ CONTENT_REQUIRE_REVIEW=true：只会发布审核通过（approved）的题目，AI 草稿不会发布。");
  }
  const r = await upsertQuestions(bundle.questions, { autoPublish, reviewer: "seed" });
  log(`题目：新建 ${r.created}，更新 ${r.updated}，未变 ${r.unchanged}，本次发布 ${r.published}`);
  if (r.errors.length) throw new Error(`题目导入错误：${r.errors.join("; ")}`);

  await syncLevelsAndMocks(bundle);
  log(`关卡 ${bundle.levels.length} 个、模考 ${bundle.mocks.length} 套已同步`);
  await ensureDefaultSettings();

  if (e.ADMIN_EMAIL && e.ADMIN_INITIAL_PASSWORD) {
    const [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, e.ADMIN_EMAIL.toLowerCase()));
    if (!existing) {
      const u = await createAccount({ email: e.ADMIN_EMAIL, password: e.ADMIN_INITIAL_PASSWORD, name: "管理员", role: "admin" });
      await db.update(user).set({ mustChangePassword: true }).where(eq(user.id, u.id));
      log(`已创建管理员 ${e.ADMIN_EMAIL}（首次登录需修改密码）`);
    }
  }

  if (opts.tts !== false) {
    try {
      await enqueue(QUEUES.ttsPregen, {});
      log("已排队生成考官音频（由 worker 处理）");
    } catch (err) {
      log("考官音频排队失败（worker 启动时会自动补齐）：", (err as Error).message);
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).includes("seed");
if (isMain) {
  seed({ tts: !process.argv.includes("--no-tts") })
    .then(async () => {
      console.log("种子数据导入完成");
      await stopBoss();
      await closeDb();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error("种子数据导入失败：", err);
      await stopBoss().catch(() => {});
      await closeDb().catch(() => {});
      process.exit(1);
    });
}
