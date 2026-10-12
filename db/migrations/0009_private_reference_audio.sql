-- Older shared caches may contain personalized reference answers. Keep them closed
-- until public question/phrase preparation explicitly identifies them as public.
ALTER TABLE "tts_asset" ADD COLUMN "is_private" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tts_asset" ALTER COLUMN "is_private" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "tts_asset" ADD COLUMN "answer_id" text REFERENCES "answer"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX "tts_asset_answer_idx" ON "tts_asset" ("answer_id");
