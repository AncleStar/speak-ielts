import "./_env";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { pcmFixture } from "./make-fixtures";

if (!process.argv.includes("--real")) throw new Error("请加 --real；本检查使用合成人声调用真实 ASR/反馈，计入现有月预算。");
const { env, dataDir } = await import("@/lib/env");
if (env().AI_PROVIDER !== "dashscope" || !env().DASHSCOPE_API_KEY || env().TIME_SCALE !== 1) throw new Error("需要已配置的真实服务与 TIME_SCALE=1；不会修改 .env 或预算。");
const { providers } = await import("@/lib/providers");
if (providers().ttsKind !== "local") throw new Error("本检查要求本机自然语音，避免额外云语音费用。");
const { db, closeDb } = await import("@/lib/db");
const schema = await import("@/db/schema");
const { createAccount } = await import("@/lib/auth");
const { createSession } = await import("@/lib/services/sessions");
const { createUploadTicket, receiveAudio, getAnswerDetail } = await import("@/lib/services/answers");
const { processAnswer } = await import("@/lib/jobs/process-answer");
const { metered } = await import("@/lib/providers/metered");
const { transcodeToWav, analyzeWav, makeTempDir } = await import("@/lib/audio");
const { storedFeedbackSchema } = await import("@/lib/feedback/schema");
const { isEvidenceInTranscript } = await import("@/lib/feedback/validate");
const { wordErrorRate } = await import("@/lib/evaluation/asr");
const { FEEDBACK_PROMPT_VERSION } = await import("@/lib/feedback/prompt");
const runId = randomUUID();
const report = { at: new Date().toISOString(), runId, feedbackPromptVersion: FEEDBACK_PROMPT_VERSION, scope: "synthetic_speech_service_pipeline", qualityValidated: false, pipelinePassed: false, cleanupPassed: false, estimatedCostYuan: 0, results: [] as object[] };
let userId: string | undefined;
try {
  const user = await createAccount({ email: `qa-${runId}@example.test`, password: `${randomUUID()}aA!`, name: "系统验证（合成样本）" }); userId = user.id;
  const owner = { id: user.id, consentAt: new Date() };
  await db.update(schema.user).set({ consentAt: owner.consentAt, onboardedAt: new Date(), mustChangePassword: false }).where(eq(schema.user.id, user.id));
  const samples = [
    { id: "clear-synthetic", text: "I live in a small flat with my family. It has two bedrooms and a sunny balcony. I especially like the balcony because I can read there after work." },
    { id: "grammar-synthetic", text: "I live in a small flat with my family. There is two bedroom. Yesterday I go to the balcony and read a book. I like my home because it is quiet." },
    { id: "silence-synthetic", text: "" },
  ];
  let allPassed = true;
  for (const sample of samples) {
    const dir = await makeTempDir("ia-practice-check-");
    try {
      const input = path.join(dir, "input.wav"), wav = path.join(dir, "normalized.wav");
      const source = sample.text ? (await metered(`practice-check:${runId}:${sample.id}`, owner.id).tts(sample.text)).audio : pcmFixture(5, true);
      await fs.writeFile(input, source); await transcodeToWav(input, wav);
      const metrics = await analyzeWav(wav);
      const session = await createSession(owner, { mode: "practice", questionId: "P1-HOME-1", fresh: true });
      const ticket = await createUploadTicket(owner.id, { sessionId: session.id, planIndex: 0, kind: "main", submissionId: randomUUID(), clientDurationMs: Math.round(metrics.durationSec * 1000) });
      await receiveAudio(owner.id, ticket.answerId, ticket.ticket, await fs.readFile(wav));
      const started = Date.now();
      // Direct execution prevents racing the live queue. Uses the same upload and processing services.
      const result = await processAnswer({ answerId: ticket.answerId }, { finalAttempt: true });
      const detail = await getAnswerDetail({ id: owner.id, isAdmin: false }, ticket.answerId);
      const parsed = storedFeedbackSchema.safeParse(detail.feedback?.data);
      const evidenceValid = parsed.success && [...parsed.data.strengths, ...parsed.data.improvements].every(item => isEvidenceInTranscript(item.evidence, detail.answer.transcript ?? ""));
      const passed = sample.text ? result.status === "done" && detail.answer.transcriptMock === false && detail.feedback?.mock === false && evidenceValid : result.status === "insufficient" && detail.answer.transcript === null && !detail.feedback;
      allPassed &&= passed;
      report.results.push({ id: sample.id, passed, status: result.status, elapsedMs: Date.now() - started, durationSec: metrics.durationSec, reference: sample.text, transcript: detail.answer.transcript, wer: sample.text ? wordErrorRate(sample.text, detail.answer.transcript ?? "") : null, feedback: parsed.success ? parsed.data : null, evidenceValid: sample.text ? evidenceValid : null });
      await db.update(schema.practiceSession).set({ status: "abandoned", endedAt: new Date() }).where(eq(schema.practiceSession.id, session.id));
      console.log(`${passed ? "PASS" : "FAIL"} ${sample.id}（合成样本，非真人质量验收）`);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
  report.pipelinePassed = allPassed;
} catch {
  report.results.push({ passed: false, error: "检查中断：请检查本机服务状态、现有预算与模型配置；未保存供应商错误原文。" });
} finally {
  if (userId) {
    const usage = await db.select({ cost: schema.usageEvent.costYuan, service: schema.usageEvent.service, ok: schema.usageEvent.ok, model: schema.usageEvent.model }).from(schema.usageEvent).where(eq(schema.usageEvent.userId, userId));
    report.estimatedCostYuan = usage.reduce((total, row) => total + Number(row.cost), 0);
    report.results.push({ usage });
    try { await (await import("@/lib/services/deletion")).purgeUser(userId); report.cleanupPassed = true; } catch { report.results.push({ cleanupError: "验证账号清理失败，请管理员检查 qa- 验证账号。" }); }
  }
  const folder = path.join(dataDir(), "round3"); await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, "real-practice.json"), JSON.stringify(report, null, 2));
  console.log(`系统链路 ${report.pipelinePassed ? "通过" : "未通过"}；本次按后台单价估算 ${report.estimatedCostYuan.toFixed(6)} 元。报告：data/round3/real-practice.json`);
  await (await import("@/lib/queue")).stopBoss(); await closeDb();
  if (!report.pipelinePassed || !report.cleanupPassed) process.exitCode = 1;
}
