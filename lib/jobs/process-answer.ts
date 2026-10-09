import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { answer, feedback, practiceSession, questionVersion } from "@/db/schema";
import {
  analyzeWav,
  ASR_MAX_BASE64_BYTES,
  makeTempDir,
  transcodeToMp3,
  transcodeToWav,
  type AudioMetrics,
} from "@/lib/audio";
import type { QuestionContent } from "@/lib/content/types";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { buildFeedbackMessages, FEEDBACK_PROMPT_VERSION } from "@/lib/feedback/prompt";
import { countWords, validateFeedback } from "@/lib/feedback/validate";
import { logOps } from "@/lib/ops";
import { providers, ProviderError } from "@/lib/providers";
import { recomputeSessionOutcome } from "@/lib/services/outcome";
import type { SessionPlan } from "@/lib/sessions/plan";
import { storage } from "@/lib/storage";
import { DURATION_TOLERANCE_SECONDS } from "@/lib/timing";
import { metered } from "@/lib/providers/metered";
import { AppError } from "@/lib/errors";
import { getAiConfig } from "@/lib/ai/credentials";
import { resolveUserAi } from "@/lib/ai/runtime";
import { assertRecordingConsent, recordingConsent } from "@/lib/services/recording-consent";

/** 有效语音少于 3 秒或转写少于 8 个词时，判为"无法充分评价" */
export const MIN_SPEECH_SECONDS = 3;
export const MIN_WORDS = 8;
/** 反馈结构/证据不合格时最多重试 2 次 */
export const FEEDBACK_MAX_RETRIES = 2;

export class FatalJobError extends Error {}

export interface ProcessJob {
  answerId: string;
  mode?: "full" | "correction";
}

/**
 * 处理一条回答。各阶段结果落库，重试时跳过已完成阶段：
 * 1. 转码为 16 kHz 单声道 WAV + 静音检测（停顿指标）
 * 2. 英语转写（有效语音过短时不调用）
 * 3. 反馈生成 + 结构与证据校验（转写过少时不调用）
 */
export async function processAnswer(job: ProcessJob, ctx: { finalAttempt: boolean }) {
  const t0 = Date.now();
  const [a] = await db.select().from(answer).where(eq(answer.id, job.answerId));
  if (!a) return { skipped: "missing" };
  const [s] = await db.select().from(practiceSession).where(eq(practiceSession.id, a.sessionId));
  if (!s || s.deletedAt) return { skipped: "deleted" };
  if (a.status === "done") return { skipped: "done" };
  if (a.status === "failed" && a.processingStage === "consent_wait") return { skipped: "consent_wait" };
  const consent = await recordingConsent(a.userId);
  const checkConsent = () => assertRecordingConsent(a.userId, consent.version).then(() => {});
  const personal = (await getAiConfig(a.userId))?.mode === "personal";
  const diagnose = !personal && env().ENABLE_AUDIO_DIAGNOSIS;
  const needsAudio = !a.metrics || a.transcript === null || (diagnose && !a.diagnosis);
  if (!a.storageKey && needsAudio) {
    await db.update(answer).set({ status: "failed", error: "录音未上传" }).where(eq(answer.id, a.id));
    return { skipped: "no_audio" };
  }
  const plan = s.plan as SessionPlan;
  const item = plan.items[a.planIndex];
  const scale = plan.timeScale || 1;

  const [claimed] = await db
    .update(answer)
    .set({ status: "processing", processingStage: a.transcript === null ? "audio" : "feedback", processAttempts: a.processAttempts + 1, updatedAt: new Date() })
    .where(and(eq(answer.id, a.id), sql`${answer.processingStage} is distinct from 'consent_wait'`, sql`(${answer.status} <> 'processing' or ${answer.updatedAt} < ${new Date(Date.now() - 15 * 60000)})`))
    .returning({ id: answer.id });
  if (!claimed) return { skipped: "processing" };

  try {
    await checkConsent();
    // ---------- 阶段 1：音频分析 ----------
    let metrics = a.metrics as AudioMetrics | null;
    let wavPath: string | null = null;
    const dir = await makeTempDir("ia-ans-");
    try {
      if (needsAudio) {
        const inPath = path.join(dir, `in.${a.storageKey!.split(".").pop()}`);
        await fs.writeFile(inPath, await storage().get(a.storageKey!));
        wavPath = path.join(dir, "audio.wav");
        try {
          await transcodeToWav(inPath, wavPath);
        } catch (e) {
          throw new FatalJobError(`音频损坏或无法解码：${(e as Error).message.slice(0, 200)}`);
        }
        if (!metrics) {
          const measured = await analyzeWav(wavPath);
          // 服务端复核：实测时长超过上限 + 容差时做标记（计费按实测时长）
          const overLimit = !!a.limitSeconds && measured.durationSec > a.limitSeconds + DURATION_TOLERANCE_SECONDS + 1;
          metrics = { ...measured, overLimit } as AudioMetrics;
          await db
            .update(answer)
            .set({ metrics, durationMs: Math.round(measured.durationSec * 1000) })
            .where(eq(answer.id, a.id));
        }
      }

      if (metrics!.durationSec > 300 || (a.limitSeconds && metrics!.durationSec > a.limitSeconds + DURATION_TOLERANCE_SECONDS + 1)) {
        throw new FatalJobError("实测录音超过题目或语音服务时长上限，请重新作答");
      }
      if (metrics!.speechSec < MIN_SPEECH_SECONDS * scale) {
        await markInsufficient(a.id, metrics!.durationSec < 0.3 ? "no_audio" : "too_short");
        await recomputeSessionOutcome(a.sessionId);
        return { status: "insufficient" };
      }

      // ---------- 阶段 2：转写 ----------
      let transcript = a.transcript;
      if (transcript === null) {
        await db.update(answer).set({ processingStage: "transcription" }).where(eq(answer.id, a.id));
        const wav = await fs.readFile(wavPath!);
        let audio = wav;
        let mime = "audio/wav";
        if (Math.ceil(wav.length / 3) * 4 > ASR_MAX_BASE64_BYTES) {
          const mp3Path = path.join(dir, "audio.mp3");
          await transcodeToMp3(wavPath!, mp3Path);
          audio = await fs.readFile(mp3Path);
          mime = "audio/mpeg";
          if (Math.ceil(audio.length / 3) * 4 > ASR_MAX_BASE64_BYTES) {
            throw new FatalJobError("录音过长，超过语音识别的单次大小限制");
          }
        }
        const version = await loadVersion(a.questionVersionId);
        const r = await metered(`answer:${a.id}`, a.userId, checkConsent).asr({
          audio,
          mime,
          durationSec: metrics!.durationSec,
          mockHint: { speechSec: metrics!.speechSec, referenceText: version?.referenceAnswer, seed: a.id },
        });
        transcript = r.text;
        const words = countWords(transcript);
        const wpm = metrics!.speechSec > 0 ? (words / metrics!.speechSec) * 60 : null;
        metrics = { ...metrics!, wordsPerMinute: !r.mock && wpm ? Math.round(wpm) : null };
        await db.update(answer).set({ transcript, transcriptModel: r.model, transcriptMock: r.mock, metrics }).where(eq(answer.id, a.id));
      }

      // ---------- 实验性音频诊断（默认关闭） ----------
      if (diagnose && !a.diagnosis && wavPath && providers().omniAudio) {
        try {
          const r = await metered(`diagnosis:${a.id}`, a.userId, checkConsent).omniAudio({
            audio: await fs.readFile(wavPath),
            mime: "audio/wav",
            prompt: "请用中文简要描述这段英语回答中 1–2 个可观察到的发音现象（例如某个单词的重音或元音），只描述你在音频中确实听到的内容；听不清时回答“证据不足”。",
          });
          await db.update(answer).set({ diagnosis: { text: r.text.slice(0, 1000), model: r.model, experimental: true } }).where(eq(answer.id, a.id));
        } catch (e) {
          if (e instanceof AppError && e.code === "consent_required") throw e;
          await logOps("warn", "omni", a.id, `音频诊断失败：${(e as Error).message}`);
        }
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }

    await checkConsent();
    const useCorrection = a.feedbackUsesCorrection && !!a.correctedTranscript;
    const [fresh] = await db.select().from(answer).where(eq(answer.id, a.id));
    const text = useCorrection ? fresh.correctedTranscript! : fresh.transcript ?? "";
    if (!useCorrection && fresh.transcriptMock !== false && (await resolveUserAi(a.userId)).provider.name !== "mock") {
      throw new FatalJobError("这段历史转写来自演示服务。请重新录音以获取真实识别，或先核对并修正全文再生成文本反馈");
    }
    if (countWords(text) < MIN_WORDS) {
      await markInsufficient(a.id, "too_few_words");
      await recomputeSessionOutcome(a.sessionId);
      return { status: "insufficient" };
    }

    // ---------- 阶段 3：反馈 ----------
    await db.update(answer).set({ processingStage: "feedback" }).where(eq(answer.id, a.id));
    const [current] = await db
      .select({ id: feedback.id, basedOnCorrection: feedback.basedOnCorrection })
      .from(feedback)
      .where(and(eq(feedback.answerId, a.id), eq(feedback.isCurrent, true)));
    if (!current || (useCorrection && job.mode === "correction")) {
      const ok = await generateFeedback({
        answerRow: fresh,
        text,
        useCorrection,
        plan,
        itemRule: item?.itemRule ?? "明确回应题目",
        minEffectiveSeconds: a.kind === "main" ? item?.minEffectiveSeconds : undefined,
        checkConsent,
      });
      if (!ok) {
        await db
          .update(answer)
          .set({ status: "failed", error: "反馈生成失败：模型输出不合格（已重试）", updatedAt: new Date() })
          .where(eq(answer.id, a.id));
        await logOps("error", "feedback", a.id, "反馈结构或证据校验多次失败", Date.now() - t0);
        await recomputeSessionOutcome(a.sessionId);
        return { status: "failed" };
      }
    }

    await db
      .update(answer)
      .set({ status: "done", processingStage: "complete", error: null, processedAt: new Date(), updatedAt: new Date() })
      .where(eq(answer.id, a.id));
    await logOps("info", "answer", a.id, "处理完成", Date.now() - t0);
    await recomputeSessionOutcome(a.sessionId);
    return { status: "done" };
  } catch (e) {
    if (e instanceof AppError && e.code === "consent_required") {
      await db.update(answer).set({ status: "failed", processingStage: "consent_wait", error: "录音授权已撤回或改变，后续处理已暂停。重新同意后可手动重试；已完成转写保留，录音仍按原期限保存。", updatedAt: new Date() }).where(eq(answer.id, a.id));
      await logOps("warn", "answer", a.id, "录音授权改变：暂停后续请求，等待手动恢复", Date.now() - t0);
      await recomputeSessionOutcome(a.sessionId);
      return { status: "consent_wait" };
    }
    if (e instanceof AppError && ["budget_exceeded", "personal_budget_exceeded"].includes(e.code)) {
      await db.update(answer).set({ status: "failed", processingStage: "budget_wait", error: `${e.message} 已上传录音和已完成转写会保留，录音仍按原期限保存。`, updatedAt: new Date() }).where(eq(answer.id, a.id));
      await logOps("warn", "answer", a.id, "预算不足：等待手动恢复，不自动重复请求", Date.now() - t0);
      await recomputeSessionOutcome(a.sessionId);
      return { status: "budget_wait" };
    }
    const fatal = e instanceof FatalJobError || e instanceof AppError || (e instanceof ProviderError && !e.retryable);
    const msg = (e as Error).message.slice(0, 300);
    await logOps("error", "answer", a.id, `处理失败${fatal ? "（不重试）" : ""}：${msg}`, Date.now() - t0);
    if (fatal || ctx.finalAttempt) {
      await db
        .update(answer)
        .set({ status: "failed", error: userFacingError(e), updatedAt: new Date() })
        .where(eq(answer.id, a.id));
      await recomputeSessionOutcome(a.sessionId);
      return { status: "failed" };
    }
    await db.update(answer).set({ status: "queued", error: msg, updatedAt: new Date() }).where(eq(answer.id, a.id));
    throw e;
  }
}

function userFacingError(e: unknown): string {
  if (e instanceof AppError) return e.message;
  if (e instanceof FatalJobError) return e.message;
  if (e instanceof ProviderError) {
    if (e.status === 401 || e.status === 403) return "服务鉴权失败：个人服务请在 API 与用量页检查密钥及模型权限；站点服务请联系管理员。";
    if (e.status === 429) return "服务繁忙或额度受限，请稍后重试；管理员可检查服务额度";
    if (e.status === 404 || e.status === 400) return "服务配置不匹配，请管理员核对模型名称和服务区域";
    if (/timeout|超时/i.test(e.message)) return "服务响应超时，已完成的转写会保留；可以稍后重试处理";
    return "语音或反馈服务暂时不可用，可稍后重试";
  }
  return "处理失败，可稍后重试";
}

async function markInsufficient(answerId: string, reason: "no_audio" | "too_short" | "too_few_words") {
  await db
    .update(answer)
    .set({ status: "insufficient", insufficientReason: reason, processedAt: new Date(), updatedAt: new Date() })
    .where(eq(answer.id, answerId));
}

async function loadVersion(versionId: string): Promise<QuestionContent | null> {
  const [v] = await db.select({ content: questionVersion.content }).from(questionVersion).where(eq(questionVersion.id, versionId));
  return (v?.content as QuestionContent) ?? null;
}

async function generateFeedback(opts: {
  answerRow: typeof answer.$inferSelect;
  text: string;
  useCorrection: boolean;
  plan: SessionPlan;
  itemRule: string;
  minEffectiveSeconds?: number;
  checkConsent: () => Promise<void>;
}): Promise<boolean> {
  const a = opts.answerRow;
  const m = (a.metrics ?? {}) as AudioMetrics;
  const version = await loadVersion(a.questionVersionId);
  const msgs = buildFeedbackMessages({
    part: a.part as 1 | 2 | 3,
    kind: a.kind as "main" | "followup" | "rounding",
    question: a.promptText,
    card: a.kind === "main" ? version?.card : undefined,
    itemRule: opts.itemRule,
    transcript: opts.text,
    basedOnCorrection: opts.useCorrection,
    metrics: {
      durationSec: m.durationSec ?? 0,
      speechSec: m.speechSec ?? 0,
      pauseCount: m.pauseCount ?? 0,
      longestPauseSec: m.longestPauseSec ?? 0,
      wordsPerMinute: m.wordsPerMinute ?? null,
    },
    minEffectiveSeconds: opts.minEffectiveSeconds,
  });
  for (let attempt = 0; attempt <= FEEDBACK_MAX_RETRIES; attempt++) {
    const r = await metered(`feedback:${a.id}`, a.userId, opts.checkConsent).llmJson({
      purpose: "feedback",
      ...msgs,
      mockHint: {
        transcript: opts.text,
        question: a.promptText,
        reference: version?.referenceAnswer,
        speechSec: m.speechSec,
        pauseCount: m.pauseCount,
      },
    });
    const v = validateFeedback(r.json ?? r.raw, opts.text, {
      minEffectiveSeconds: opts.minEffectiveSeconds,
      effectiveSeconds: m.speechSec,
    });
    if (!v.ok) {
      await logOps("warn", "feedback", a.id, `第 ${attempt + 1} 次输出不合格：${v.reason} ${v.detail.slice(0, 200)}`);
      continue;
    }
    await db.transaction(async (tx) => {
      await tx.update(feedback).set({ isCurrent: false }).where(eq(feedback.answerId, a.id));
      await tx.insert(feedback).values({
        answerId: a.id,
        basedOnCorrection: opts.useCorrection,
        isCurrent: true,
        data: v.feedback,
        goalMet: v.feedback.goal.met,
        goalReason: v.feedback.goal.reason,
        droppedEvidence: v.dropped,
        model: r.model,
        promptVersion: FEEDBACK_PROMPT_VERSION,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        mock: r.mock || a.transcriptMock !== false,
      });
    });
    return true;
  }
  return false;
}
