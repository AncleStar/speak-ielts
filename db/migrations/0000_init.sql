CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "answer" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"question_id" text NOT NULL,
	"question_version_id" text NOT NULL,
	"plan_index" integer NOT NULL,
	"part" integer NOT NULL,
	"kind" text DEFAULT 'main' NOT NULL,
	"follow_up_id" text,
	"prompt_text" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"submission_id" text NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"storage_key" text,
	"mime_type" text,
	"size_bytes" integer,
	"client_duration_ms" integer,
	"limit_seconds" integer,
	"duration_ms" integer,
	"metrics" jsonb,
	"transcript" text,
	"transcript_model" text,
	"corrected_transcript" text,
	"insufficient_reason" text,
	"error" text,
	"interrupted" boolean DEFAULT false NOT NULL,
	"process_attempts" integer DEFAULT 0 NOT NULL,
	"diagnosis" jsonb,
	"audio_deleted_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deletion_log" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"target_id" text NOT NULL,
	"user_id" text,
	"requested_by" text,
	"reason" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"answer_id" text NOT NULL,
	"based_on_correction" boolean DEFAULT false NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"data" jsonb NOT NULL,
	"goal_met" boolean DEFAULT false NOT NULL,
	"goal_reason" text DEFAULT '' NOT NULL,
	"dropped_evidence" integer DEFAULT 0 NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"mock" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "level" (
	"id" text PRIMARY KEY NOT NULL,
	"scenario" text DEFAULT 'ielts_speaking' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"chapter" integer NOT NULL,
	"order" integer NOT NULL,
	"title" text NOT NULL,
	"question_ids" jsonb NOT NULL,
	"mock_set_id" text,
	"timing" jsonb NOT NULL,
	"hints" jsonb NOT NULL,
	"goal_rule" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mock_set" (
	"id" text PRIMARY KEY NOT NULL,
	"scenario" text DEFAULT 'ielts_speaking' NOT NULL,
	"title" text NOT NULL,
	"plan" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops_log" (
	"id" text PRIMARY KEY NOT NULL,
	"level" text NOT NULL,
	"kind" text NOT NULL,
	"ref" text,
	"message" text NOT NULL,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "practice_session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"scenario" text DEFAULT 'ielts_speaking' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"mode" text NOT NULL,
	"level_id" text,
	"mock_set_id" text,
	"question_id" text,
	"source_answer_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"plan" jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"current_part" integer,
	"part_deadlines" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"part_starts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"skipped" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reserved_seconds" integer DEFAULT 0 NOT NULL,
	"time_scale" double precision DEFAULT 1 NOT NULL,
	"report" jsonb,
	"interrupt_reason" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "progress" (
	"user_id" text NOT NULL,
	"level_id" text NOT NULL,
	"completed_at" timestamp with time zone,
	"goal_met_at" timestamp with time zone,
	"best_session_id" text,
	"best_goal_count" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "progress_user_id_level_id_pk" PRIMARY KEY("user_id","level_id")
);
--> statement-breakpoint
CREATE TABLE "question" (
	"id" text PRIMARY KEY NOT NULL,
	"scenario" text DEFAULT 'ielts_speaking' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"part" integer NOT NULL,
	"topic" text NOT NULL,
	"current_version_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_version" (
	"id" text PRIMARY KEY NOT NULL,
	"question_id" text NOT NULL,
	"version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"content" jsonb NOT NULL,
	"review_status" text DEFAULT 'ai_draft' NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"source_type" text DEFAULT 'original' NOT NULL,
	"review_note" text,
	"reviewed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retry_item" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"question_id" text NOT NULL,
	"source_answer_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"impersonated_by" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "session_event" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tts_asset" (
	"id" text PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"text" text NOT NULL,
	"voice" text NOT NULL,
	"model" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"storage_key" text,
	"mime_type" text,
	"duration_ms" integer,
	"mock" boolean DEFAULT false NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tts_asset_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "usage_event" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"service" text NOT NULL,
	"model" text NOT NULL,
	"job_ref" text,
	"units" jsonb NOT NULL,
	"cost_yuan" double precision DEFAULT 0 NOT NULL,
	"mock" boolean DEFAULT false NOT NULL,
	"latency_ms" integer,
	"ok" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"role" text DEFAULT 'user',
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"must_change_password" boolean DEFAULT true NOT NULL,
	"target_band" text,
	"self_level" text,
	"subtitle_pref" text DEFAULT 'auto' NOT NULL,
	"consent_at" timestamp with time zone,
	"onboarded_at" timestamp with time zone,
	"allow_admin_view" boolean DEFAULT false NOT NULL,
	"daily_quota_minutes" integer,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer" ADD CONSTRAINT "answer_session_id_practice_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."practice_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer" ADD CONSTRAINT "answer_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_answer_id_answer_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."answer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_session" ADD CONSTRAINT "practice_session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress" ADD CONSTRAINT "progress_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_version" ADD CONSTRAINT "question_version_question_id_question_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."question"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retry_item" ADD CONSTRAINT "retry_item_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_event" ADD CONSTRAINT "session_event_session_id_practice_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."practice_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "answer_submission_uq" ON "answer" USING btree ("session_id","submission_id");--> statement-breakpoint
CREATE INDEX "answer_session_idx" ON "answer" USING btree ("session_id","plan_index");--> statement-breakpoint
CREATE INDEX "answer_user_question_idx" ON "answer" USING btree ("user_id","question_id");--> statement-breakpoint
CREATE INDEX "answer_status_idx" ON "answer" USING btree ("status");--> statement-breakpoint
CREATE INDEX "feedback_answer_idx" ON "feedback" USING btree ("answer_id","is_current");--> statement-breakpoint
CREATE INDEX "ops_log_created_idx" ON "ops_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "practice_session_user_idx" ON "practice_session" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "practice_session_status_idx" ON "practice_session" USING btree ("status","last_activity_at");--> statement-breakpoint
CREATE INDEX "question_part_topic_idx" ON "question" USING btree ("scenario","part","topic");--> statement-breakpoint
CREATE UNIQUE INDEX "question_version_q_v_uq" ON "question_version" USING btree ("question_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "retry_item_open_uq" ON "retry_item" USING btree ("user_id","question_id") WHERE "retry_item"."done_at" is null;--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_event_session_idx" ON "session_event" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "usage_event_created_idx" ON "usage_event" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "usage_event_user_idx" ON "usage_event" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");