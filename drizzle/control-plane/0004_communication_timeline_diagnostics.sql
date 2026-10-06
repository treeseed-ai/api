CREATE TABLE IF NOT EXISTS "communication_topic_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"topic_id" text NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"agent_slug" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"source" text NOT NULL,
	"subscribed_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "communication_topic_subscriptions_topic_fk" FOREIGN KEY ("topic_id") REFERENCES "communication_discussion_topics"("id") ON DELETE cascade,
	CONSTRAINT "communication_topic_subscriptions_team_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade,
	CONSTRAINT "communication_topic_subscriptions_project_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade,
	CONSTRAINT "communication_topic_subscriptions_unique" UNIQUE("topic_id", "project_id", "agent_slug"),
	CONSTRAINT "communication_topic_subscriptions_status" CHECK ("status" IN ('active','removed')),
	CONSTRAINT "communication_topic_subscriptions_source" CHECK ("source" IN ('mention','operator','seed'))
);

CREATE TABLE IF NOT EXISTS "communication_topic_events" (
	"sequence" bigserial PRIMARY KEY,
	"id" text NOT NULL UNIQUE,
	"topic_id" text NOT NULL,
	"team_id" text NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"send_id" text,
	"invocation_id" text,
	"assignment_id" text,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_handle" text,
	"summary" text NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "communication_topic_events_topic_fk" FOREIGN KEY ("topic_id") REFERENCES "communication_discussion_topics"("id") ON DELETE cascade,
	CONSTRAINT "communication_topic_events_team_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade,
	CONSTRAINT "communication_topic_events_type" CHECK ("event_type" IN ('message.posted','mention.acknowledged','response_lease.accepted','agent.progress','agent.response','agent.abstained','agent.failed'))
);

CREATE TABLE IF NOT EXISTS "communication_execution_trace_events" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"topic_id" text NOT NULL,
	"send_id" text,
	"invocation_id" text,
	"assignment_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"summary" text NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"protected_payload_json" jsonb,
	"protected_payload_expires_at" timestamp with time zone,
	CONSTRAINT "communication_execution_trace_events_team_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade,
	CONSTRAINT "communication_execution_trace_events_topic_fk" FOREIGN KEY ("topic_id") REFERENCES "communication_discussion_topics"("id") ON DELETE cascade,
	CONSTRAINT "communication_execution_trace_events_assignment_fk" FOREIGN KEY ("assignment_id") REFERENCES "capacity_provider_assignments"("id") ON DELETE cascade,
	CONSTRAINT "communication_execution_trace_events_sequence_unique" UNIQUE("assignment_id", "sequence")
);

ALTER TABLE "capacity_provider_assignments"
	ADD COLUMN IF NOT EXISTS "communication_acknowledged_at" timestamp with time zone,
	ADD COLUMN IF NOT EXISTS "communication_lease_accepted_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "communication_topic_subscriptions_list_idx"
	ON "communication_topic_subscriptions" ("team_id", "topic_id", "status", "project_id", "agent_slug");
CREATE INDEX IF NOT EXISTS "communication_topic_events_timeline_idx"
	ON "communication_topic_events" ("team_id", "topic_id", "sequence");
CREATE INDEX IF NOT EXISTS "communication_trace_assignment_idx"
	ON "communication_execution_trace_events" ("assignment_id", "sequence");
CREATE INDEX IF NOT EXISTS "communication_trace_expiry_idx"
	ON "communication_execution_trace_events" ("protected_payload_expires_at");
