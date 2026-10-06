CREATE TABLE IF NOT EXISTS "inbox_items" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"markdown" text NOT NULL,
	"status" text DEFAULT 'outstanding' NOT NULL,
	"author_id" text NOT NULL,
	"author_label" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"discussion_id" text,
	"repository_id" text,
	"content_path" text,
	"commit_sha" text,
	"digest" text,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "inbox_items_team_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade,
	CONSTRAINT "inbox_items_project_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade,
	CONSTRAINT "inbox_items_kind" CHECK ("kind" IN ('proposal','question')),
	CONSTRAINT "inbox_items_status" CHECK ("status" IN ('outstanding','answered','approved','rejected','closed','deleted'))
);

CREATE TABLE IF NOT EXISTS "inbox_drafts" (
	"item_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"purpose" text NOT NULL,
	"markdown" text NOT NULL,
	"base_version" integer NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	PRIMARY KEY ("item_id", "principal_id", "purpose"),
	CONSTRAINT "inbox_drafts_item_fk" FOREIGN KEY ("item_id") REFERENCES "inbox_items"("id") ON DELETE cascade,
	CONSTRAINT "inbox_drafts_purpose" CHECK ("purpose" IN ('feedback','proposal_revision'))
);

CREATE TABLE IF NOT EXISTS "inbox_events" (
	"sequence" bigserial PRIMARY KEY,
	"id" text NOT NULL UNIQUE,
	"team_id" text NOT NULL,
	"item_id" text,
	"event_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"summary" text NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "inbox_events_team_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade,
	CONSTRAINT "inbox_events_item_fk" FOREIGN KEY ("item_id") REFERENCES "inbox_items"("id") ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS "inbox_action_receipts" (
	"team_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"item_id" text,
	"action" text NOT NULL,
	"result_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	PRIMARY KEY ("team_id", "idempotency_key")
);

CREATE INDEX IF NOT EXISTS "inbox_items_timeline_idx" ON "inbox_items" ("team_id", "status", "updated_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "inbox_items_project_idx" ON "inbox_items" ("team_id", "project_id", "kind", "updated_at" DESC);
CREATE INDEX IF NOT EXISTS "inbox_events_cursor_idx" ON "inbox_events" ("team_id", "sequence");
