import type { Metadata } from "next";
import Link from "next/link";
import { publishApprovedAction, setReviewAction } from "@/app/actions/admin";
import { ImportForm, PublishToggle } from "@/components/admin/question-forms";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/form";
import { REVIEW_STATUS_LABEL, REVIEW_STATUSES } from "@/lib/content/types";
import { env } from "@/lib/env";
import { listQuestionVersions } from "@/lib/services/admin";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "管理 · 题库审核" };

export default async function AdminQuestions({ searchParams }: { searchParams: Promise<{ part?: string; status?: string; q?: string }> }) {
  const sp = await searchParams;
  const part = sp.part ? Number(sp.part) : undefined;
  const rows = await listQuestionVersions({ part, status: sp.status, q: sp.q });
  const all = await listQuestionVersions({});
  const count = (s: string) => all.filter((r) => r.reviewStatus === s).length;
  const requireReview = env().CONTENT_REQUIRE_REVIEW;
  return (
    <>
      <PageHeader
        title="题库审核与发布"
        description="审核状态：AI 起草 → 英语表达已审 → 题型已审 → 通过；发布是独立开关。内容变化时自动生成新版本，已开始的会话继续使用原版本。"
      />
      <Alert tone={requireReview ? "info" : "warning"} className="mb-4">
        {requireReview
          ? "生产发布门槛已开启（CONTENT_REQUIRE_REVIEW=true）：只能发布审核通过的题目；关卡中任一题目未发布时显示“内容准备中”。"
          : "发布门槛未开启：允许发布 AI 草稿（仅用于开发与模拟试用），界面会标记“AI 草稿·未人工审核”。"}
      </Alert>
      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>审核进度</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {REVIEW_STATUSES.map((s) => (
              <p key={s}>
                {REVIEW_STATUS_LABEL[s]}：{count(s)}
              </p>
            ))}
            <p>已发布：{all.filter((r) => r.publishedVersion !== null).length} / {all.length}</p>
            <form action={publishApprovedAction} className="pt-2">
              <Button type="submit" size="sm" variant="secondary">
                发布全部审核通过的题目
              </Button>
            </form>
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>导入题库 JSON</CardTitle>
          </CardHeader>
          <CardContent>
            <ImportForm />
          </CardContent>
        </Card>
      </div>

      <form className="mb-3 flex flex-wrap items-end gap-2" method="get">
        <Select name="part" defaultValue={sp.part ?? ""} className="h-9 w-32">
          <option value="">全部部分</option>
          <option value="1">Part 1</option>
          <option value="2">Part 2</option>
          <option value="3">Part 3</option>
        </Select>
        <Select name="status" defaultValue={sp.status ?? ""} className="h-9 w-40">
          <option value="">全部状态</option>
          {REVIEW_STATUSES.map((s) => (
            <option key={s} value={s}>
              {REVIEW_STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
        <Input name="q" defaultValue={sp.q ?? ""} placeholder="编号或题目文字" className="h-9 w-48" />
        <Button type="submit" size="sm">
          筛选
        </Button>
        <Link href="/admin/questions" className="text-sm text-muted underline">
          清除
        </Link>
      </form>

      <p className="mb-2 text-sm text-muted">共 {rows.length} 条（显示每道题的最新版本）</p>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.id} className="rounded-xl border border-line bg-white p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="muted">{r.questionId}</Badge>
              <Badge>v{r.version}</Badge>
              <Badge tone={r.reviewStatus === "approved" ? "success" : r.reviewStatus === "ai_draft" ? "warning" : "brand"}>
                {REVIEW_STATUS_LABEL[r.reviewStatus as keyof typeof REVIEW_STATUS_LABEL]}
              </Badge>
              {r.publishedVersion !== null ? (
                <Badge tone={r.publishedVersion === r.version ? "success" : "warning"}>已发布 v{r.publishedVersion}</Badge>
              ) : (
                <Badge tone="danger">未发布</Badge>
              )}
              <Badge tone="muted">{r.sourceType === "original" ? "原创" : "授权"}</Badge>
              <span className="min-w-0 flex-1 truncate text-sm">{r.content.text}</span>
            </div>
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer text-brand-700">审核</summary>
              <div className="mt-2 space-y-2">
                <p className="text-muted">{r.content.zh}</p>
                <p className={cn("rounded-lg bg-slate-50 p-2 leading-relaxed")}>{r.content.referenceAnswer}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <form action={setReviewAction} className="flex items-center gap-2">
                    <input type="hidden" name="versionId" value={r.id} />
                    <Select name="status" defaultValue={r.reviewStatus} className="h-9 w-40">
                      {REVIEW_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {REVIEW_STATUS_LABEL[s]}
                        </option>
                      ))}
                    </Select>
                    <Input name="note" placeholder="审核备注（可选）" className="h-9 w-48" />
                    <Button type="submit" size="sm" variant="outline">
                      更新审核状态
                    </Button>
                  </form>
                  <PublishToggle versionId={r.id} published={r.publishedVersion === r.version} />
                </div>
                {r.reviewedBy ? <p className="text-xs text-muted">最近操作：{r.reviewedBy}</p> : null}
              </div>
            </details>
          </li>
        ))}
      </ul>
    </>
  );
}
