import type { Metadata } from "next";
import { togglePauseAction } from "@/app/actions/admin";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/feedback";
import { serviceStatus, trialMetrics } from "@/lib/services/admin";
import { ANSWER_STATUS_LABEL, formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "管理 · 服务状态" };

export default async function AdminHome() {
  const [s, m] = await Promise.all([serviceStatus(), trialMetrics()]);
  const workerStale = !s.workerReady;
  return (
    <>
      <PageHeader title="服务状态" description="默认只显示运行状态和统计；查看用户回答需要用户在设置中授权。" />
      {s.config.timeScale !== 1 ? <Alert tone="danger" className="mb-4">TIME_SCALE={s.config.timeScale}：测试时间倍率已启用，生产环境必须为 1。</Alert> : null}
      {s.config.aiProvider === "mock" ? <Alert tone="warning" className="mb-4">当前为模拟服务模式（AI_PROVIDER=mock），转写与反馈为演示数据，不计为真实能力验收。</Alert> : null}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>运行开关</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              新会话：{s.paused ? <Badge tone="danger">已暂停</Badge> : <Badge tone="success">正常</Badge>}　当前活动面试：{s.activeSessions}
            </p>
            <p className="text-xs text-muted">发现录音丢失、越权访问或明显错误反馈时，暂停新会话（保留历史访问），回滚应用并排查。</p>
            <form action={togglePauseAction}>
              <input type="hidden" name="pause" value={s.paused ? "false" : "true"} />
              <Button type="submit" variant={s.paused ? "primary" : "danger-outline"}>
                {s.paused ? "恢复新会话" : "暂停新会话"}
              </Button>
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>配置</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>AI 服务：{s.config.aiProvider}　存储：{s.config.storage}</p>
            <p>百炼密钥：{s.config.credentialsConfigured ? "已配置（需完成真实连通与质量验证）" : "未配置，真实转写与反馈尚未启用"}</p>
            <p>发布门槛：{s.config.requireReview ? "只发布审核通过的题目" : "允许发布草稿（开发/模拟试用）"}</p>
            <p>音频诊断（实验）：{s.config.audioDiagnosis ? "开启" : "关闭"}</p>
            <p className="text-xs text-muted">
              ASR {s.config.models.asr} · TTS {s.config.models.tts}（{s.config.models.voice}） · LLM {s.config.models.llm}
            </p>
            <p>
              数据库 {s.dbOk ? <Badge tone="success">正常</Badge> : <Badge tone="danger">异常</Badge>}　任务队列 {s.queueOk ? <Badge tone="success">正常</Badge> : <Badge tone="danger">异常</Badge>}
              后台处理最近心跳 {s.lastWorkerActivity ? formatDateTime(s.lastWorkerActivity) : "无"} {workerStale ? <Badge tone="warning">后台未就绪，请检查或重启应用</Badge> : <Badge tone="success">在线</Badge>}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>后台任务</CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1">队列</th>
                  <th>排队</th>
                  <th>进行中</th>
                  <th>失败</th>
                </tr>
              </thead>
              <tbody>
                {s.queues.map((q) => (
                  <tr key={q.name} className="border-t border-line">
                    <td className="py-1">{q.name}</td>
                    <td>{q.queued}</td>
                    <td>{q.active}</td>
                    <td>{q.failed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-sm">
              回答状态：
              {s.answerStatus.map((a) => (
                <span key={a.status} className="mr-3">
                  {ANSWER_STATUS_LABEL[a.status] ?? a.status} {a.n}
                </span>
              ))}
            </p>
            <p className="mt-1 text-sm">
              近 24 小时反馈耗时：平均 {s.feedbackLatency.avgSec.toFixed(1)} 秒，P95 {s.feedbackLatency.p95Sec.toFixed(1)} 秒（{s.feedbackLatency.n} 条）
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>试用指标（近 30 天）</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2 text-sm">
            <p>录音上传成功率：{m.uploadSuccessRate ?? "—"}%</p>
            <p>处理失败率：{m.processFailRate ?? "—"}%</p>
            <p>无法充分评价：{m.insufficientRate ?? "—"}%</p>
            <p>模考完成率：{m.mockCompletionRate ?? "—"}%</p>
            <p>重练使用率：{m.retryUsageRate ?? "—"}%</p>
            <p>回答总数：{m.answers}</p>
          </CardContent>
        </Card>
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>近 24 小时异常</CardTitle>
          </CardHeader>
          <CardContent>
            {s.errors.length === 0 ? (
              <p className="text-sm text-muted">无</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {s.errors.map((e) => (
                  <li key={e.id} className="flex flex-wrap gap-2">
                    <Badge tone={e.level === "error" ? "danger" : "warning"}>{e.kind}</Badge>
                    <span className="text-xs text-muted">{formatDateTime(e.createdAt)}</span>
                    <span className="font-mono text-xs text-muted">{e.ref}</span>
                    <span>{e.message}</span>
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
