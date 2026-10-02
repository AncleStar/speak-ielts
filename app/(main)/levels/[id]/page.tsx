import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { StartSessionButton } from "@/components/start-session-button";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/feedback";
import { requireUser } from "@/lib/auth-server";
import { getChapter } from "@/lib/content/load";
import type { Hints } from "@/lib/content/types";
import { getLevelDetail } from "@/lib/services/reports";
import { publishedVersions } from "@/lib/services/content";

export const metadata: Metadata = { title: "关卡详情" };

const HINT_LABELS: [keyof Hints, string][] = [
  ["showText", "英文题目字幕"],
  ["showZh", "中文理解"],
  ["showKeywords", "关键词"],
  ["showExpressions", "可用表达"],
  ["showStructure", "组织思路"],
  ["showCard", "任务卡"],
  ["notes", "便签"],
];

export default async function LevelDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await requireUser();
  const { id } = await params;
  const l = await getLevelDetail(u.id, id);
  if (!l) notFound();
  const ch = getChapter(l.chapter);
  const isMock = !!l.mockSetId;
  const pv = await publishedVersions(l.questionIds);
  const timing = ch.timing;
  const hints = l.hints as Hints;
  const draft = [...pv.values()].some((v) => v.reviewStatus !== "approved");

  return (
    <>
      <PageHeader title={`${l.id} ${l.title}`} description={`第 ${ch.chapter} 章 · ${ch.title}：${ch.focus}`} />
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>本关目标</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-[15px]">
            <p>{ch.goal.description}</p>
            <p className="text-sm text-muted">每道题的判断依据：{ch.goal.itemRule}</p>
            {!isMock ? (
              <div className="space-y-1">
                <p className="text-sm font-medium">题目（{l.questionIds.length} 道{ch.chapter === 5 ? "主问题，每道追加 1 道追问" : ""}）</p>
                <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
                  {l.questionIds.map((qid) => (
                    <li key={qid}>{pv.get(qid)?.content.text ?? `${qid}（内容准备中）`}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-muted">完整模考：Part 1 两个主题 → Part 2 任务卡 → Part 3 深度讨论。模考中问答字幕默认隐藏。</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>计时与提示</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {isMock ? (
              <p>Part 1 4:30 · Part 2 3:30 · Part 3 4:30（共 12:30）</p>
            ) : (
              <ul className="space-y-1">
                {timing.prepSeconds ? <li>准备 {timing.prepSeconds} 秒</li> : null}
                <li>作答 {timing.answerSeconds} 秒{ch.part === 2 ? "（最长）" : "/题"}</li>
                {timing.followUpSeconds ? <li>追问 {timing.followUpSeconds} 秒</li> : null}
                <li className="text-xs text-muted">以上为训练设置，不代表官方单题时限</li>
              </ul>
            )}
            <div className="flex flex-wrap gap-1.5">
              {HINT_LABELS.filter(([k]) => hints[k]).map(([k, label]) => (
                <Badge key={k} tone="brand">
                  {label}
                </Badge>
              ))}
            </div>
            <p className="text-xs text-muted">{ch.hintNote}</p>
          </CardContent>
        </Card>
      </div>

      <div className="mt-5 space-y-3">
        {!l.available ? <Alert tone="warning">内容准备中：本关部分题目尚未发布。</Alert> : null}
        {draft ? <Alert tone="warning">本关题目与参考回答为 AI 草稿，尚未经人工审核。</Alert> : null}
        {!l.unlocked ? <Alert tone="info">完成上一关后解锁本关，无需积分。已有基础可前往自由题库或完整模考。</Alert> : null}
        <div className="flex flex-wrap items-start gap-3">
          {l.available && l.unlocked ? (
            <StartSessionButton input={{ mode: "level", levelId: l.id }} size="lg" testId="start-level">
              {l.activeSessionId ? "继续本关" : isMock ? "开始模考" : "开始本关"}
            </StartSessionButton>
          ) : null}
          <LinkButton href="/device-check" variant="outline" size="lg">
            检查麦克风
          </LinkButton>
          {l.bestSessionId ? (
            <LinkButton href={`/sessions/${l.bestSessionId}`} variant="ghost" size="lg">
              查看最佳记录
            </LinkButton>
          ) : null}
        </div>
        <p className="text-xs text-muted">
          状态：{l.completed ? "已完成" : "未完成"} · {l.goalMet ? "目标已达成" : "目标未达成"} · 练习 {l.attempts} 次
        </p>
      </div>
    </>
  );
}
