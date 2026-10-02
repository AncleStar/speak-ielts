import { and, desc, eq, ne } from "drizzle-orm";
import type { Metadata } from "next";
import { regenerateTtsAction } from "@/app/actions/admin";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ttsAsset } from "@/db/schema";
import { db } from "@/lib/db";
import { ttsStatusCounts } from "@/lib/services/tts";

export const metadata: Metadata = { title: "管理 · 考官音频" };

export default async function AdminTts() {
  const c = await ttsStatusCounts();
  const problems = await db.select().from(ttsAsset).where(and(eq(ttsAsset.model, c.model), eq(ttsAsset.voice, c.voice), ne(ttsAsset.status, "ready"))).orderBy(desc(ttsAsset.updatedAt)).limit(20);
  return (
    <>
      <PageHeader title="考官音频" description="题目发布后预生成音频并保存。声音切换后会生成新缓存，已有练习刷新后也会使用当前声音。" />
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>当前型号：{c.model}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>当前声音：{c.label ?? c.voice}</p>
            <p>
              已就绪 <Badge tone="success">{c.ready}</Badge> 生成中 <Badge tone="muted">{c.pending}</Badge> 失败 <Badge tone="danger">{c.failed}</Badge>
            </p>
            {c.otherModels ? <p className="text-xs text-muted">另有 {c.otherModels} 条其他型号/音色的旧音频（切换服务后会重新生成）。</p> : null}
            <form action={regenerateTtsAction}>
              <Button type="submit" variant="secondary" size="sm">
                补齐缺失并重试失败的音频
              </Button>
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>未就绪的音频</CardTitle>
          </CardHeader>
          <CardContent>
            {problems.length === 0 ? (
              <p className="text-sm text-muted">全部就绪</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {problems.map((p) => (
                  <li key={p.id}>
                    <Badge tone={p.status === "failed" ? "danger" : "muted"}>{p.status}</Badge> {p.text.slice(0, 60)}
                    {p.error ? <span className="block text-xs text-red-700">{p.error}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
