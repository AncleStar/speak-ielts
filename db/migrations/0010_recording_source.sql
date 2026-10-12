ALTER TABLE "answer" ADD COLUMN "recording_activation_id" text;--> statement-breakpoint
-- Existing accepted answers remain unchanged; only new declarations are classified.
ALTER TABLE "answer" ADD COLUMN "recording_source" text DEFAULT 'accepted' NOT NULL;
