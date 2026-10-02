import { desc, isNull } from "drizzle-orm";
import { minuteCredit, opsLog, rewardLedger, user } from "@/db/schema";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-server";
import { getSettings } from "@/lib/settings";
import { RewardsAdminForms } from "@/components/rewards/admin-forms";
import { formatDateTime } from "@/lib/utils";
export default async function AdminRewardsPage() {
  await requireAdmin(); const [settings, users, ledger, credits, logs] = await Promise.all([getSettings(), db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(isNull(user.deletedAt)), db.select().from(rewardLedger).orderBy(desc(rewardLedger.createdAt)).limit(50), db.select().from(minuteCredit).orderBy(desc(minuteCredit.createdAt)).limit(30), db.select().from(opsLog).orderBy(desc(opsLog.createdAt)).limit(100)]);
  const names = new Map(users.map(u => [u.id, u.name]));
  return <div className="space-y-6"><div><p className="eyebrow">REWARDS OPERATIONS</p><h1 className="page-title">积分与兑换管理</h1></div><RewardsAdminForms settings={settings.rewards} users={users} />
    <section><h2 className="mb-3 font-semibold">最近 50 笔积分流水</h2><ul className="divide-y divide-line">{ledger.map(l => <li key={l.id} className="flex flex-wrap justify-between gap-2 py-3 text-sm"><span>{names.get(l.userId) ?? "已删除用户"} · {l.note}{l.actorId ? ` · 操作人 ${names.get(l.actorId) ?? l.actorId}` : ""}</span><span>{l.points > 0 ? "+" : ""}{l.points} · {formatDateTime(l.createdAt)}</span></li>)}</ul></section>
    <section><h2 className="mb-3 font-semibold">最近 30 张分钟券</h2><ul className="divide-y divide-line">{credits.map(c => <li key={c.id} className="space-y-1 py-3 text-sm"><p>{names.get(c.userId)} · 可用 {(c.remainingSeconds / 60).toFixed(1)} / {c.totalSeconds / 60} 分钟 · {formatDateTime(c.expiresAt)} 到期</p><p className="break-all font-mono text-xs text-muted">{c.id}</p></li>)}</ul></section><details><summary className="cursor-pointer py-3 font-semibold">规则及延期操作审计</summary><ul className="space-y-3 text-xs text-muted">{logs.filter(l => ["rewards-settings", "credit-extension"].includes(l.kind)).map(l => <li key={l.id} className="break-all">{formatDateTime(l.createdAt)} · {l.ref} · {l.message}</li>)}</ul></details>
  </div>;
}
