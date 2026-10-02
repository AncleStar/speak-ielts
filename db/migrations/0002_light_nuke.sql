CREATE TABLE "review_completion" (
	"session_id" text NOT NULL,
	"question_id" text NOT NULL,
	CONSTRAINT "review_completion_session_id_question_id_pk" PRIMARY KEY("session_id","question_id")
);
--> statement-breakpoint
CREATE TABLE "review_schedule" (
	"user_id" text NOT NULL,
	"question_id" text NOT NULL,
	"completed_count" integer DEFAULT 0 NOT NULL,
	"next_due_at" timestamp with time zone NOT NULL,
	"last_practiced_at" timestamp with time zone NOT NULL,
	CONSTRAINT "review_schedule_user_id_question_id_pk" PRIMARY KEY("user_id","question_id")
);
--> statement-breakpoint
CREATE TABLE "signup_invite" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"email" text,
	"created_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signup_invite_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "signup_limit" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "answer" ADD COLUMN "transcript_mock" boolean;--> statement-breakpoint
ALTER TABLE "answer" ADD COLUMN "processing_stage" text;--> statement-breakpoint
ALTER TABLE "answer" ADD COLUMN "feedback_uses_correction" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "answer" SET "transcript_mock" = CASE WHEN "transcript_model" LIKE 'mock%' THEN true WHEN "transcript_model" IS NOT NULL THEN false ELSE NULL END WHERE "transcript" IS NOT NULL;--> statement-breakpoint
UPDATE "answer" SET "feedback_uses_correction" = true WHERE EXISTS (SELECT 1 FROM "feedback" WHERE "feedback"."answer_id" = "answer"."id" AND "feedback"."is_current" AND "feedback"."based_on_correction");--> statement-breakpoint
ALTER TABLE "review_completion" ADD CONSTRAINT "review_completion_session_id_practice_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."practice_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_schedule" ADD CONSTRAINT "review_schedule_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Preserve completed practice, but remove legacy ability badges supported only by mock feedback.
UPDATE "progress" p SET "goal_met_at" = NULL, "best_goal_count" = 0
WHERE p."goal_met_at" IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM "practice_session" s JOIN "answer" a ON a."session_id" = s."id"
 JOIN "feedback" f ON f."answer_id" = a."id"
 WHERE s."user_id" = p."user_id" AND s."level_id" = p."level_id" AND f."mock" = false AND f."goal_met" = true
);
