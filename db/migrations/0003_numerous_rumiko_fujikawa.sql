CREATE TABLE "user_ai_config" (
	"user_id" text PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'platform' NOT NULL,
	"key_ciphertext" text,
	"key_last4" text,
	"asr_model" text DEFAULT 'qwen3-asr-flash-2026-02-10' NOT NULL,
	"llm_model" text DEFAULT 'qwen-plus' NOT NULL,
	"monthly_budget_yuan" double precision DEFAULT 20 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_event" ADD COLUMN "billing_source" text DEFAULT 'platform' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_ai_config" ADD CONSTRAINT "user_ai_config_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;