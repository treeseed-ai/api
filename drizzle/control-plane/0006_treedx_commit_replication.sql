CREATE TABLE IF NOT EXISTS "treedx_commit_replications" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"source_ref" text NOT NULL,
	"github_ref" text NOT NULL,
	"r2_object_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"github_status" text DEFAULT 'pending' NOT NULL,
	"r2_status" text DEFAULT 'pending' NOT NULL,
	"github_receipt_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"r2_receipt_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "treedx_commit_replications_team_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade,
	CONSTRAINT "treedx_commit_replications_project_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade,
	CONSTRAINT "treedx_commit_replications_commit_sha" CHECK ("commit_sha" ~ '^[a-f0-9]{40}$'),
	CONSTRAINT "treedx_commit_replications_status" CHECK ("status" IN ('pending','replicating','degraded','complete')),
	CONSTRAINT "treedx_commit_replications_github_status" CHECK ("github_status" IN ('pending','replicating','failed','verified')),
	CONSTRAINT "treedx_commit_replications_r2_status" CHECK ("r2_status" IN ('pending','replicating','failed','verified')),
	CONSTRAINT "treedx_commit_replications_project_commit_unique" UNIQUE ("project_id", "commit_sha")
);

CREATE INDEX IF NOT EXISTS "treedx_commit_replications_retry_idx"
	ON "treedx_commit_replications" ("status", "next_attempt_at", "created_at");
CREATE INDEX IF NOT EXISTS "treedx_commit_replications_project_idx"
	ON "treedx_commit_replications" ("project_id", "created_at" DESC);
