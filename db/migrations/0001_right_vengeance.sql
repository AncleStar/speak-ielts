INSERT INTO "app_setting" ("key", "value") VALUES ('rewardsStartedAt', to_jsonb(now()::text)) ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE "content_entitlement" (
	"user_id" text NOT NULL,
	"pack_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_entitlement_user_id_pack_id_pk" PRIMARY KEY("user_id","pack_id")
);
--> statement-breakpoint
CREATE TABLE "daily_checkin" (
	"user_id" text NOT NULL,
	"day" text NOT NULL,
	"streak" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_checkin_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
CREATE TABLE "minute_credit" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"redemption_key" text NOT NULL,
	"total_seconds" integer NOT NULL,
	"remaining_seconds" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quota_hold" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"day" text NOT NULL,
	"base_seconds" integer NOT NULL,
	"credits" jsonb NOT NULL,
	"settled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_visit" (
	"user_id" text NOT NULL,
	"answer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_visit_user_id_answer_id_pk" PRIMARY KEY("user_id","answer_id")
);
--> statement-breakpoint
CREATE TABLE "reward_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"event_key" text NOT NULL,
	"kind" text NOT NULL,
	"points" integer NOT NULL,
	"day" text NOT NULL,
	"note" text NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_entitlement" ADD CONSTRAINT "content_entitlement_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_checkin" ADD CONSTRAINT "daily_checkin_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "minute_credit" ADD CONSTRAINT "minute_credit_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_hold" ADD CONSTRAINT "quota_hold_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_visit" ADD CONSTRAINT "review_visit_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_visit" ADD CONSTRAINT "review_visit_answer_id_answer_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."answer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_ledger" ADD CONSTRAINT "reward_ledger_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_redemption_uq" ON "minute_credit" USING btree ("user_id","redemption_key");--> statement-breakpoint
CREATE UNIQUE INDEX "quota_hold_session_day_uq" ON "quota_hold" USING btree ("session_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "reward_event_uq" ON "reward_ledger" USING btree ("user_id","event_key");--> statement-breakpoint
CREATE INDEX "reward_user_day_idx" ON "reward_ledger" USING btree ("user_id","day");
