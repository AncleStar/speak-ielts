import type { Metadata } from "next";
import Link from "next/link";
import { deleteUserAction, setBannedAction, setQuotaAction } from "@/app/actions/admin";
import { CreateUserForm, ResetPasswordForm } from "@/components/admin/user-forms";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/form";
import { requireAdmin } from "@/lib/auth-server";
import { listUsers, userAnswersForAdmin } from "@/lib/services/admin";
import { getSettings } from "@/lib/settings";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "管理 · 账号" };

export default async function AdminUsers({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const admin = await requireAdmin();
  const { view } = await searchParams;
  const [users, settings] = await Promise.all([listUsers(), getSettings()]);
  const viewAnswers = view ? await userAnswersForAdmin(view) : null;
  return (
    <>
      <PageHeader title="账号管理" description={`已开放 ${users.length} 个账号（首轮建议不超过 10 个）。公开注册已关闭；密码找回由管理员重置。`} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>创建试用账号</CardTitle>
          </CardHeader>
          <CardContent>
            <CreateUserForm defaultQuota={settings.limits.dailyMinutes} />
          </CardContent>
        </Card>
        <div className="space-y-3 lg:col-span-2">
          {users.map((u) => (
            <Card key={u.id} data-testid={`user-${u.email}`}>
              <CardContent className="space-y-3 pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{u.name}</span>
                  <span className="text-sm text-muted">{u.email}</span>
                  {u.role === "admin" ? <Badge tone="brand">管理员</Badge> : null}
                  {u.banned ? <Badge tone="danger">已停用</Badge> : null}
                  {u.mustChangePassword ? <Badge tone="warning">待改初始密码</Badge> : null}
                  {!u.consentAt ? <Badge tone="muted">未同意录音说明</Badge> : null}
                  {u.allowAdminView ? <Badge tone="success">已授权排查</Badge> : null}
                </div>
                <p className="text-xs text-muted">
                  创建于 {formatDateTime(u.createdAt)} · {u.sessions} 次练习 · 最近活动 {u.lastActive ? formatDateTime(u.lastActive) : "—"}
                </p>
                <div className="flex flex-wrap items-end gap-3">
                  <form action={setQuotaAction} className="flex items-end gap-2">
                    <input type="hidden" name="userId" value={u.id} />
                    <label className="text-xs text-muted">
                      每日额度（分钟，空=默认 {settings.limits.dailyMinutes}）
                      <Input name="minutes" type="number" min={0} defaultValue={u.dailyQuotaMinutes ?? ""} className="h-9 w-28" />
                    </label>
                    <Button type="submit" size="sm" variant="outline">
                      保存额度
                    </Button>
                  </form>
                  <ResetPasswordForm userId={u.id} />
                  {u.id !== admin.id ? (
                    <>
                      <form action={setBannedAction}>
                        <input type="hidden" name="userId" value={u.id} />
                        <input type="hidden" name="banned" value={u.banned ? "false" : "true"} />
                        <Button type="submit" size="sm" variant="outline">
                          {u.banned ? "恢复账号" : "停用账号"}
                        </Button>
                      </form>
                      <form action={deleteUserAction}>
                        <input type="hidden" name="userId" value={u.id} />
                        <Button type="submit" size="sm" variant="danger-outline">
                          删除账号及数据
                        </Button>
                      </form>
                    </>
                  ) : null}
                  {u.allowAdminView ? (
                    <Link href={`/admin/users?view=${u.id}`} className="text-sm text-brand-700 underline">
                      查看回答（已授权）
                    </Link>
                  ) : null}
                </div>
                {view === u.id && viewAnswers ? (
                  <ul className="space-y-1 rounded-lg bg-slate-50 p-3 text-sm">
                    {viewAnswers.length === 0 ? <li className="text-muted">暂无回答</li> : null}
                    {viewAnswers.map((a) => (
                      <li key={a.id}>
                        <Link href={`/answers/${a.id}`} className="text-brand-700 underline">
                          {formatDateTime(a.createdAt)} · {a.promptText.slice(0, 60)}
                        </Link>{" "}
                        <span className="text-xs text-muted">{a.status}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </>
  );
}
