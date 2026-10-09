CREATE TABLE "personal_thought" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"source_text" text NOT NULL,
	"title" text NOT NULL,
	"analysis" text NOT NULL,
	"simple" text NOT NULL,
	"natural" text NOT NULL,
	"nuanced" text NOT NULL,
	"vocabulary" jsonb NOT NULL,
	"model" text NOT NULL,
	"mock" boolean NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thought_generation" (
	"user_id" text NOT NULL,
	"request_id" text NOT NULL,
	"source_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"thought_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thought_generation_user_id_request_id_pk" PRIMARY KEY("user_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "thought_practice" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"thought_id" text NOT NULL,
	"request_id" text NOT NULL,
	"thought_revision" integer NOT NULL,
	"natural_text" text NOT NULL,
	"recalled_text" text DEFAULT '' NOT NULL,
	"outcome" text NOT NULL,
	"duration_seconds" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thought_review" (
	"thought_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"natural_text" text NOT NULL,
	"completed_count" integer DEFAULT 0 NOT NULL,
	"next_due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vocabulary_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"term" text NOT NULL,
	"normalized_term" text NOT NULL,
	"meaning" text NOT NULL,
	"example" text DEFAULT '' NOT NULL,
	"thought_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "personal_thought" ADD CONSTRAINT "personal_thought_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thought_generation" ADD CONSTRAINT "thought_generation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thought_generation" ADD CONSTRAINT "thought_generation_thought_id_personal_thought_id_fk" FOREIGN KEY ("thought_id") REFERENCES "public"."personal_thought"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thought_practice" ADD CONSTRAINT "thought_practice_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thought_practice" ADD CONSTRAINT "thought_practice_thought_id_personal_thought_id_fk" FOREIGN KEY ("thought_id") REFERENCES "public"."personal_thought"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thought_review" ADD CONSTRAINT "thought_review_thought_id_personal_thought_id_fk" FOREIGN KEY ("thought_id") REFERENCES "public"."personal_thought"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thought_review" ADD CONSTRAINT "thought_review_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vocabulary_entry" ADD CONSTRAINT "vocabulary_entry_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vocabulary_entry" ADD CONSTRAINT "vocabulary_entry_thought_id_personal_thought_id_fk" FOREIGN KEY ("thought_id") REFERENCES "public"."personal_thought"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thought_user_updated_idx" ON "personal_thought" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "thought_generation_rate_idx" ON "thought_generation" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "thought_practice_request_uq" ON "thought_practice" USING btree ("user_id","request_id");--> statement-breakpoint
CREATE INDEX "thought_practice_thought_idx" ON "thought_practice" USING btree ("thought_id","created_at");--> statement-breakpoint
CREATE INDEX "thought_review_user_due_idx" ON "thought_review" USING btree ("user_id","next_due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "vocabulary_user_term_uq" ON "vocabulary_entry" USING btree ("user_id","normalized_term");--> statement-breakpoint
CREATE INDEX "vocabulary_user_updated_idx" ON "vocabulary_entry" USING btree ("user_id","updated_at");