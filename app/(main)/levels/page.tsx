import { CheckCircle2, Lock, Star } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { requireUser } from "@/lib/auth-server";
import { loadContent } from "@/lib/content/load";
import { getLevelMap } from "@/lib/services/reports";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "关卡地图" };

export default async function LevelsPage() {
  const u = await requireUser();
  const { levels } = await getLevelMap(u.id);
  const currentId = levels.find(l => l.available && l.unlocked && !l.completed && l.chapter <= 5)?.id;
  const chapters = loadContent().chapters;
  return (
    <>
      <PageHeader
        title="关卡地图"
        description="第 1–5 章按顺序解锁，完成上一关即可进入下一关，无需积分。“目标达成”另行记录，不影响解锁。自由题库与完整模考始终开放。"
      />
      <div className="space-y-6">
        {chapters.map((ch) => (
          <section key={ch.chapter}>
            <div className="mb-2 flex flex-wrap items-baseline gap-2">
              <h2 className="text-lg font-semibold">
                第 {ch.chapter} 章 · {ch.title}
              </h2>
              <span className="text-sm text-muted">{ch.focus}</span>
            </div>
            <p className="mb-3 text-xs text-muted">目标：{ch.goal.description}</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {levels
                .filter((l) => l.chapter === ch.chapter)
                .map((l) => (
                  <Link
                    key={l.id}
                    href={`/levels/${l.id}`}
                    data-testid={`level-${l.id}`}
                    className={cn(
                      "relative flex min-h-24 flex-col justify-between rounded-2xl border bg-white p-3 transition-colors hover:border-brand-300",
                      l.goalMet ? "border-emerald-300" : l.completed ? "border-brand-200" : "border-line",
                      !l.unlocked && "bg-slate-50",
                      l.id === currentId && "border-brand-400 ring-2 ring-brand-200",
                    )}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <span className="text-xs font-semibold text-muted">{l.id}</span>
                      {l.goalMet ? (
                        <Star className="h-4 w-4 fill-emerald-500 text-emerald-500" aria-label="目标达成" />
                      ) : l.completed ? (
                        <CheckCircle2 className="h-4 w-4 text-brand-600" aria-label="已完成" />
                      ) : !l.unlocked ? (
                        <Lock className="h-4 w-4 text-slate-400" aria-label="完成上一关后解锁" />
                      ) : null}
                    </div>
                    <p className="text-[15px] font-medium leading-snug">{l.title}</p>
                    <div className="flex flex-wrap gap-1">
                      {l.id === currentId ? <Badge tone="brand">下一关</Badge> : null}
                      {!l.available ? <Badge tone="muted">内容准备中</Badge> : null}
                      {l.activeSessionId ? <Badge tone="brand">进行中</Badge> : null}
                      {l.goalMet ? <Badge tone="success">目标达成</Badge> : l.completed ? <Badge tone="brand">已完成</Badge> : null}
                    </div>
                  </Link>
                ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
