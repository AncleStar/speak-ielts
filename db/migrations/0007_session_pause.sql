ALTER TABLE "practice_session" ADD COLUMN "state_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "practice_session" ADD COLUMN "activation_id" text;--> statement-breakpoint
ALTER TABLE "practice_session" ADD COLUMN "paused_uploads" jsonb DEFAULT '[]'::jsonb NOT NULL;