import "./_env";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, isNull, like } from "drizzle-orm";
import { appSetting, practiceSession, session, signupInvite } from "@/db/schema";
import { dataDir } from "@/lib/env";
import { db, closeDb } from "@/lib/db";
import { replayDeletions } from "@/lib/services/deletion";
import { runMigrations } from "./migrate";

try {
  const root = dataDir(), pending = path.join(root, "restore-pending.json");
  if (process.env.RESTORE_FINALIZE !== "true" || !await fs.stat(pending).then(s => s.isFile(), () => false)) throw new Error("仅可由隔离恢复流程运行");
  await runMigrations();
  const deletions = await replayDeletions();
  await db.transaction(async tx => {
    await tx.delete(session);
    await tx.delete(appSetting).where(like(appSetting.key, "runtime:worker:%"));
    await tx.update(signupInvite).set({ revokedAt: new Date() }).where(and(isNull(signupInvite.usedAt), isNull(signupInvite.revokedAt)));
    await tx.update(practiceSession).set({ status: "interrupted", endedAt: new Date() }).where(eq(practiceSession.status, "active"));
  });
  await fs.writeFile(path.join(root, "restore-complete.json"), JSON.stringify({ completedAt: new Date().toISOString(), deletions,
    authenticationSessionsRevoked: true, unusedInvitesRevoked: true, activeInterviewsInterrupted: true, servicesStarted: false }, null, 2), { flag: "wx", mode: 0o600, flush: true });
  await fs.rm(pending);
} catch { console.error("恢复迁移或删除重放失败，保留失败目录与数据库，请勿启动该环境。"); process.exitCode = 1; }
finally { await closeDb(); }
