CREATE TABLE IF NOT EXISTS "communication_discussion_topics" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "communication_discussion_topics_team_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade,
	CONSTRAINT "communication_discussion_topics_team_slug_unique" UNIQUE("team_id", "slug"),
	CONSTRAINT "communication_discussion_topics_status" CHECK ("status" IN ('active', 'archived'))
);

CREATE TABLE IF NOT EXISTS "communication_discussion_streams" (
	"id" text PRIMARY KEY NOT NULL,
	"topic_id" text NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"discussion_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "communication_discussion_streams_topic_fk" FOREIGN KEY ("topic_id") REFERENCES "communication_discussion_topics"("id") ON DELETE cascade,
	CONSTRAINT "communication_discussion_streams_team_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade,
	CONSTRAINT "communication_discussion_streams_project_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade,
	CONSTRAINT "communication_discussion_streams_topic_project_unique" UNIQUE("topic_id", "project_id"),
	CONSTRAINT "communication_discussion_streams_discussion_unique" UNIQUE("discussion_id")
);

CREATE INDEX IF NOT EXISTS "communication_discussion_topics_team_idx"
	ON "communication_discussion_topics" ("team_id", "status", "slug");
CREATE INDEX IF NOT EXISTS "communication_discussion_streams_team_project_idx"
	ON "communication_discussion_streams" ("team_id", "project_id", "topic_id");
