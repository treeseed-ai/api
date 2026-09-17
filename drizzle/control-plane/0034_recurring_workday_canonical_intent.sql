ALTER TABLE "capacity_workday_schedules" ADD COLUMN "intent_json" text;
--> statement-breakpoint
UPDATE "capacity_workday_schedules" SET "intent_json" = jsonb_strip_nulls(jsonb_build_object(
  'schemaVersion', 'treeseed.workday-intent/v1', 'teamId', "team_id", 'profileId', 'default',
  'projects', "project_ids_json"::jsonb, 'startsAt', "next_run_at", 'durationSeconds', "duration_seconds",
  'planningOnly', "planning_only" = 1,
  'agentSelection', (SELECT jsonb_object_agg(key, value) FROM jsonb_each("agent_selection_json"::jsonb)
    WHERE key IN ('agentSlugs', 'activityTypes', 'classIds', 'classSlugs')
    AND jsonb_typeof(value) = 'array' AND value <> '[]'::jsonb),
  'operatorConstraints', jsonb_build_object('providerIds', jsonb_build_array("capacity_provider_id"), 'maxConcurrency', "max_active_assignments")
))::text;
--> statement-breakpoint
ALTER TABLE "capacity_workday_schedules" ALTER COLUMN "intent_json" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "capacity_workday_schedules"
  DROP COLUMN "capacity_provider_id", DROP COLUMN "project_ids_json", DROP COLUMN "agent_selection_json",
  DROP COLUMN "duration_seconds", DROP COLUMN "max_active_assignments", DROP COLUMN "available_seconds",
  DROP COLUMN "time_policy_json", DROP COLUMN "planning_only", DROP COLUMN "publication_policy_json";
