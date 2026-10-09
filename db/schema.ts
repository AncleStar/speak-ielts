import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

// ============================================================
// Better Auth 标准表（含 admin 插件字段）+ 业务扩展字段
// ============================================================

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  // admin 插件
  role: text("role").default("user"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: ts("ban_expires"),
  // 业务扩展
  mustChangePassword: boolean("must_change_password").notNull().default(true),
  targetBand: text("target_band"),
  selfLevel: text("self_level"),
  subtitlePref: text("subtitle_pref").notNull().default("auto"),
  consentAt: ts("consent_at"),
  onboardedAt: ts("onboarded_at"),
  allowAdminView: boolean("allow_admin_view").notNull().default(false),
  dailyQuotaMinutes: integer("daily_quota_minutes"),
  deletedAt: ts("deleted_at"),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: ts("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// ============================================================
// 题库与编排
// ============================================================

/** 题目标识（如 P1-HOME-1）。内容快照在 question_version 中。 */
export const question = pgTable(
  "question",
  {
    id: text("id").primaryKey(),
    scenario: text("scenario").notNull().default("ielts_speaking"),
    language: text("language").notNull().default("en"),
    part: integer("part").notNull(),
    topic: text("topic").notNull(),
    currentVersionId: text("current_version_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("question_part_topic_idx").on(t.scenario, t.part, t.topic)],
);

/** 审核状态：ai_draft → language_reviewed → format_reviewed → approved；发布为独立开关。 */
export const questionVersion = pgTable(
  "question_version",
  {
    id: id(),
    questionId: text("question_id")
      .notNull()
      .references(() => question.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    contentHash: text("content_hash").notNull(),
    content: jsonb("content").notNull(),
    reviewStatus: text("review_status").notNull().default("ai_draft"),
    published: boolean("published").notNull().default(false),
    sourceType: text("source_type").notNull().default("original"),
    reviewNote: text("review_note"),
    reviewedBy: text("reviewed_by"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("question_version_q_v_uq").on(t.questionId, t.version)],
);

export const level = pgTable("level", {
  id: text("id").primaryKey(), // 如 "1-1"
  scenario: text("scenario").notNull().default("ielts_speaking"),
  language: text("language").notNull().default("en"),
  chapter: integer("chapter").notNull(),
  order: integer("order").notNull(),
  title: text("title").notNull(),
  questionIds: jsonb("question_ids").$type<string[]>().notNull(),
  mockSetId: text("mock_set_id"),
  timing: jsonb("timing").notNull(),
  hints: jsonb("hints").notNull(),
  goalRule: jsonb("goal_rule").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const mockSet = pgTable("mock_set", {
  id: text("id").primaryKey(), // 如 "mock-1"
  scenario: text("scenario").notNull().default("ielts_speaking"),
  title: text("title").notNull(),
  plan: jsonb("plan").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

// ============================================================
// 练习会话与回答
// ============================================================

export const practiceSession = pgTable(
  "practice_session",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    scenario: text("scenario").notNull().default("ielts_speaking"),
    language: text("language").notNull().default("en"),
    /** level | mock | practice | retry */
    mode: text("mode").notNull(),
    levelId: text("level_id"),
    mockSetId: text("mock_set_id"),
    questionId: text("question_id"),
    sourceAnswerId: text("source_answer_id"),
    /** active | completed | interrupted | abandoned */
    status: text("status").notNull().default("active"),
    plan: jsonb("plan").notNull(),
    position: integer("position").notNull().default(0),
    currentPart: integer("current_part"),
    partDeadlines: jsonb("part_deadlines").$type<Record<string, string>>().notNull().default({}),
    partStarts: jsonb("part_starts").$type<Record<string, string>>().notNull().default({}),
    skipped: jsonb("skipped").$type<number[]>().notNull().default([]),
    reservedSeconds: integer("reserved_seconds").notNull().default(0),
    timeScale: doublePrecision("time_scale").notNull().default(1),
    report: jsonb("report"),
    interruptReason: text("interrupt_reason"),
    startedAt: ts("started_at"),
    endedAt: ts("ended_at"),
    lastActivityAt: ts("last_activity_at").notNull().defaultNow(),
    deletedAt: ts("deleted_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("practice_session_user_idx").on(t.userId, t.createdAt),
    index("practice_session_status_idx").on(t.status, t.lastActivityAt),
  ],
);

/** 事件幂等：客户端生成事件标识，重复提交直接忽略。 */
export const sessionEvent = pgTable(
  "session_event",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => practiceSession.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload"),
    result: jsonb("result"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("session_event_session_idx").on(t.sessionId)],
);

export const answer = pgTable(
  "answer",
  {
    id: id(),
    sessionId: text("session_id")
      .notNull()
      .references(() => practiceSession.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    questionId: text("question_id").notNull(),
    questionVersionId: text("question_version_id").notNull(),
    planIndex: integer("plan_index").notNull(),
    part: integer("part").notNull(),
    /** main | followup | rounding */
    kind: text("kind").notNull().default("main"),
    followUpId: text("follow_up_id"),
    promptText: text("prompt_text").notNull(),
    attempt: integer("attempt").notNull().default(1),
    submissionId: text("submission_id").notNull(),
    /** created | uploaded | queued | processing | done | insufficient | failed */
    status: text("status").notNull().default("created"),
    storageKey: text("storage_key"),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes"),
    clientDurationMs: integer("client_duration_ms"),
    limitSeconds: integer("limit_seconds"),
    durationMs: integer("duration_ms"),
    metrics: jsonb("metrics"),
    transcript: text("transcript"),
    transcriptModel: text("transcript_model"),
    transcriptMock: boolean("transcript_mock"),
    processingStage: text("processing_stage"),
    feedbackUsesCorrection: boolean("feedback_uses_correction").notNull().default(false),
    correctedTranscript: text("corrected_transcript"),
    insufficientReason: text("insufficient_reason"),
    error: text("error"),
    interrupted: boolean("interrupted").notNull().default(false),
    processAttempts: integer("process_attempts").notNull().default(0),
    diagnosis: jsonb("diagnosis"),
    audioDeletedAt: ts("audio_deleted_at"),
    submittedAt: ts("submitted_at"),
    processedAt: ts("processed_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("answer_submission_uq").on(t.sessionId, t.submissionId),
    index("answer_session_idx").on(t.sessionId, t.planIndex),
    index("answer_user_question_idx").on(t.userId, t.questionId),
    index("answer_status_idx").on(t.status),
  ],
);

export const feedback = pgTable(
  "feedback",
  {
    id: id(),
    answerId: text("answer_id")
      .notNull()
      .references(() => answer.id, { onDelete: "cascade" }),
    basedOnCorrection: boolean("based_on_correction").notNull().default(false),
    isCurrent: boolean("is_current").notNull().default(true),
    data: jsonb("data").notNull(),
    goalMet: boolean("goal_met").notNull().default(false),
    goalReason: text("goal_reason").notNull().default(""),
    droppedEvidence: integer("dropped_evidence").notNull().default(0),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    mock: boolean("mock").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("feedback_answer_idx").on(t.answerId, t.isCurrent)],
);

export const progress = pgTable(
  "progress",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    levelId: text("level_id").notNull(),
    completedAt: ts("completed_at"),
    goalMetAt: ts("goal_met_at"),
    bestSessionId: text("best_session_id"),
    bestGoalCount: integer("best_goal_count").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.levelId] })],
);

export const retryItem = pgTable(
  "retry_item",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    questionId: text("question_id").notNull(),
    sourceAnswerId: text("source_answer_id"),
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow(),
    doneAt: ts("done_at"),
  },
  (t) => [
    uniqueIndex("retry_item_open_uq").on(t.userId, t.questionId).where(sql`${t.doneAt} is null`),
  ],
);

// ============================================================
// 语音资源、用量与设置
// ============================================================

/** Codes are stored as hashes; one invite creates one ordinary account. */
export const signupInvite = pgTable("signup_invite", {
  id: id(), codeHash: text("code_hash").notNull().unique(), email: text("email"),
  createdBy: text("created_by").notNull(), expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"), usedBy: text("used_by"), revokedAt: ts("revoked_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
export const signupLimit = pgTable("signup_limit", {
  key: text("key").primaryKey(), count: integer("count").notNull().default(0),
  expiresAt: ts("expires_at").notNull(),
});
/** Only completed valid practices advance spacing, once per session/question. */
export const reviewSchedule = pgTable("review_schedule", {
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  questionId: text("question_id").notNull(),
  completedCount: integer("completed_count").notNull().default(0),
  nextDueAt: ts("next_due_at").notNull(), lastPracticedAt: ts("last_practiced_at").notNull(),
}, t => [primaryKey({ columns: [t.userId, t.questionId] })]);
export const reviewCompletion = pgTable("review_completion", {
  sessionId: text("session_id").notNull().references(() => practiceSession.id, { onDelete: "cascade" }),
  questionId: text("question_id").notNull(),
}, t => [primaryKey({ columns: [t.sessionId, t.questionId] })]);

// Personal Thought Lab: user material is independent of the published question bank.
export const personalThought = pgTable("personal_thought", {
  id: id(), userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  sourceText: text("source_text").notNull(), title: text("title").notNull(), analysis: text("analysis").notNull(),
  simple: text("simple").notNull(), natural: text("natural").notNull(), nuanced: text("nuanced").notNull(),
  vocabulary: jsonb("vocabulary").$type<{ term: string; meaning: string; example: string }[]>().notNull(),
  model: text("model").notNull(), mock: boolean("mock").notNull(), edited: boolean("edited").notNull().default(false),
  revision: integer("revision").notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(), updatedAt: ts("updated_at").notNull().defaultNow(),
}, t => [index("thought_user_updated_idx").on(t.userId, t.updatedAt)]);

export const thoughtGeneration = pgTable("thought_generation", {
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  requestId: text("request_id").notNull(), sourceHash: text("source_hash").notNull(),
  status: text("status").notNull().default("pending"),
  thoughtId: text("thought_id").references(() => personalThought.id, { onDelete: "set null" }),
  createdAt: ts("created_at").notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.userId, t.requestId] }), index("thought_generation_rate_idx").on(t.userId, t.createdAt)]);

export const thoughtReview = pgTable("thought_review", {
  thoughtId: text("thought_id").primaryKey().references(() => personalThought.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  naturalText: text("natural_text").notNull(), completedCount: integer("completed_count").notNull().default(0),
  nextDueAt: ts("next_due_at").notNull().defaultNow(), lastReviewedAt: ts("last_reviewed_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, t => [index("thought_review_user_due_idx").on(t.userId, t.nextDueAt)]);

export const thoughtPractice = pgTable("thought_practice", {
  id: id(), userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  thoughtId: text("thought_id").notNull().references(() => personalThought.id, { onDelete: "cascade" }),
  requestId: text("request_id").notNull(), thoughtRevision: integer("thought_revision").notNull(),
  naturalText: text("natural_text").notNull(), recalledText: text("recalled_text").notNull().default(""),
  outcome: text("outcome").notNull(), durationSeconds: doublePrecision("duration_seconds").notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
}, t => [uniqueIndex("thought_practice_request_uq").on(t.userId, t.requestId), index("thought_practice_thought_idx").on(t.thoughtId, t.createdAt)]);

export const vocabularyEntry = pgTable("vocabulary_entry", {
  id: id(), userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  term: text("term").notNull(), normalizedTerm: text("normalized_term").notNull(),
  meaning: text("meaning").notNull(), example: text("example").notNull().default(""),
  thoughtId: text("thought_id").references(() => personalThought.id, { onDelete: "set null" }),
  createdAt: ts("created_at").notNull().defaultNow(), updatedAt: ts("updated_at").notNull().defaultNow(),
}, t => [uniqueIndex("vocabulary_user_term_uq").on(t.userId, t.normalizedTerm), index("vocabulary_user_updated_idx").on(t.userId, t.updatedAt)]);

export const ttsAsset = pgTable("tts_asset", {
  id: id(),
  hash: text("hash").notNull().unique(),
  text: text("text").notNull(),
  voice: text("voice").notNull(),
  model: text("model").notNull(),
  /** pending | ready | failed */
  status: text("status").notNull().default("pending"),
  storageKey: text("storage_key"),
  mimeType: text("mime_type"),
  durationMs: integer("duration_ms"),
  mock: boolean("mock").notNull().default(false),
  error: text("error"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const usageEvent = pgTable(
  "usage_event",
  {
    id: id(),
    userId: text("user_id"),
    billingSource: text("billing_source").notNull().default("platform"),
    /** asr | tts | llm | omni */
    service: text("service").notNull(),
    model: text("model").notNull(),
    jobRef: text("job_ref"),
    units: jsonb("units").notNull(),
    costYuan: doublePrecision("cost_yuan").notNull().default(0),
    mock: boolean("mock").notNull().default(false),
    latencyMs: integer("latency_ms"),
    ok: boolean("ok").notNull().default(true),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("usage_event_created_idx").on(t.createdAt), index("usage_event_user_idx").on(t.userId, t.createdAt)],
);

/** Encrypted credentials are never included in user/profile API responses. */
export const userAiConfig = pgTable("user_ai_config", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  mode: text("mode").notNull().default("platform"),
  keyCiphertext: text("key_ciphertext"),
  keyLast4: text("key_last4"),
  asrModel: text("asr_model").notNull().default("qwen3-asr-flash-2026-02-10"),
  llmModel: text("llm_model").notNull().default("qwen-plus"),
  monthlyBudgetYuan: doublePrecision("monthly_budget_yuan").notNull().default(20),
  consentedAt: ts("consented_at"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const appSetting = pgTable("app_setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const deletionLog = pgTable("deletion_log", {
  id: id(),
  /** session | user | thought | vocabulary | answer_audio */
  kind: text("kind").notNull(),
  targetId: text("target_id").notNull(),
  userId: text("user_id"),
  requestedBy: text("requested_by"),
  reason: text("reason"),
  completedAt: ts("completed_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/** 统一的错误/任务日志（不含录音、完整回答文本或密钥）。 */
export const opsLog = pgTable(
  "ops_log",
  {
    id: id(),
    level: text("level").notNull(),
    kind: text("kind").notNull(),
    ref: text("ref"),
    message: text("message").notNull(),
    durationMs: integer("duration_ms"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("ops_log_created_idx").on(t.createdAt)],
);

// Reward records deliberately keep only opaque activity references, never recordings or transcripts.
export const rewardLedger = pgTable("reward_ledger", {
  id: id(), userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  eventKey: text("event_key").notNull(), kind: text("kind").notNull(), points: integer("points").notNull(),
  day: text("day").notNull(), note: text("note").notNull(), actorId: text("actor_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, t => [uniqueIndex("reward_event_uq").on(t.userId, t.eventKey), index("reward_user_day_idx").on(t.userId, t.day)]);

export const dailyCheckin = pgTable("daily_checkin", {
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  day: text("day").notNull(), streak: integer("streak").notNull(), createdAt: ts("created_at").notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.userId, t.day] })]);

export const minuteCredit = pgTable("minute_credit", {
  id: id(), userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  redemptionKey: text("redemption_key").notNull(), totalSeconds: integer("total_seconds").notNull(),
  remainingSeconds: integer("remaining_seconds").notNull(), expiresAt: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
}, t => [uniqueIndex("credit_redemption_uq").on(t.userId, t.redemptionKey)]);

// Holds survive session deletion so deleting recordings cannot refund already consumed minutes.
export const quotaHold = pgTable("quota_hold", {
  id: id(), userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(), day: text("day").notNull(), baseSeconds: integer("base_seconds").notNull(),
  credits: jsonb("credits").$type<{ id: string; seconds: number }[]>().notNull(),
  settled: boolean("settled").notNull().default(false), createdAt: ts("created_at").notNull().defaultNow(),
}, t => [uniqueIndex("quota_hold_session_day_uq").on(t.sessionId, t.day)]);

export const reviewVisit = pgTable("review_visit", {
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  answerId: text("answer_id").notNull().references(() => answer.id, { onDelete: "cascade" }),
  createdAt: ts("created_at").notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.userId, t.answerId] })]);

// Reserved for future reviewed topic packs; no unavailable products are sold.
export const contentEntitlement = pgTable("content_entitlement", {
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  packId: text("pack_id").notNull(), createdAt: ts("created_at").notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.userId, t.packId] })]);

export const schema = {
  personalThought, thoughtGeneration, thoughtReview, thoughtPractice, vocabularyEntry,
  reviewSchedule, reviewCompletion,
  userAiConfig,
  rewardLedger, dailyCheckin, minuteCredit, quotaHold, reviewVisit, contentEntitlement,
  user,
  session,
  account,
  verification,
  question,
  questionVersion,
  level,
  mockSet,
  practiceSession,
  sessionEvent,
  answer,
  feedback,
  progress,
  retryItem,
  ttsAsset,
  usageEvent,
  appSetting,
  deletionLog,
  opsLog,
};
