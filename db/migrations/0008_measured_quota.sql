ALTER TABLE "quota_hold" ADD COLUMN "base_limit_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "quota_hold" ADD COLUMN "used_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "quota_hold" ADD COLUMN "uncovered_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Older holds did not retain the daily limit. Preserve their assigned base and snapshot the upgrade configuration.
UPDATE "quota_hold" h SET
  "base_limit_seconds" = greatest(h."base_seconds", round(coalesce(u."daily_quota_minutes"::numeric,
    (SELECT (s."value"->>'dailyMinutes')::numeric FROM "app_setting" s WHERE s."key" = 'limits'), 30) * 60)::integer),
  "used_seconds" = CASE WHEN h."settled" THEN h."base_seconds" +
    coalesce((SELECT sum((c->>'seconds')::integer) FROM jsonb_array_elements(h."credits") c), 0)::integer ELSE 0 END
FROM "user" u WHERE u."id" = h."user_id";
