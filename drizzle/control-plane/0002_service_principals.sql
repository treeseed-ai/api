CREATE TABLE IF NOT EXISTS "service_principals" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_key" text NOT NULL,
	"display_name" text NOT NULL,
	"interactive_login" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "service_principals_key_unique" UNIQUE("principal_key"),
	CONSTRAINT "service_principals_non_login" CHECK ("interactive_login" = false),
	CONSTRAINT "service_principals_status" CHECK ("status" IN ('active', 'retired'))
);

CREATE TABLE IF NOT EXISTS "team_service_principal_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"service_principal_id" text NOT NULL,
	"roles_json" text DEFAULT '[]' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"seed_name" text,
	"resource_key" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "team_service_principal_membership_team_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade,
	CONSTRAINT "team_service_principal_membership_principal_fk" FOREIGN KEY ("service_principal_id") REFERENCES "service_principals"("id") ON DELETE cascade,
	CONSTRAINT "team_service_principal_membership_unique" UNIQUE("team_id", "service_principal_id"),
	CONSTRAINT "team_service_principal_membership_seed_unique" UNIQUE("seed_name", "resource_key"),
	CONSTRAINT "team_service_principal_membership_status" CHECK ("status" IN ('active', 'removed'))
);

CREATE INDEX IF NOT EXISTS "team_service_principal_memberships_team_idx"
	ON "team_service_principal_memberships" ("team_id", "status");

ALTER TABLE "capacity_provider_lanes" DROP CONSTRAINT IF EXISTS "chk_capacity_provider_lanes_purpose";
UPDATE "capacity_provider_lanes" SET "purpose" = 'workday' WHERE "purpose" = 'operation';
ALTER TABLE "capacity_provider_lanes" ALTER COLUMN "purpose" DROP DEFAULT;
ALTER TABLE "capacity_provider_lanes" ADD CONSTRAINT "chk_capacity_provider_lanes_purpose"
	CHECK ("purpose" IN ('communication', 'platform', 'workday'));
ALTER TABLE "capacity_provider_lanes" ADD COLUMN IF NOT EXISTS "priority" integer DEFAULT 0 NOT NULL;
ALTER TABLE "capacity_provider_lanes" ADD COLUMN IF NOT EXISTS "reserved_concurrent_workers" integer DEFAULT 0 NOT NULL;
ALTER TABLE "capacity_provider_lanes" ADD COLUMN IF NOT EXISTS "borrow_when_idle" boolean DEFAULT false NOT NULL;
ALTER TABLE "capacity_provider_lanes" ADD COLUMN IF NOT EXISTS "lend_when_idle" boolean DEFAULT false NOT NULL;
ALTER TABLE "capacity_provider_lanes" ADD COLUMN IF NOT EXISTS "queue_limit" integer DEFAULT 0 NOT NULL;
ALTER TABLE "capacity_provider_lanes" ADD COLUMN IF NOT EXISTS "timeout_seconds" integer DEFAULT 300 NOT NULL;

ALTER TABLE "capacity_provider_assignments" DROP CONSTRAINT IF EXISTS "chk_capacity_provider_assignments_lane_purpose";
UPDATE "capacity_provider_assignments" SET "lane_purpose" = 'workday' WHERE "lane_purpose" = 'operation';
ALTER TABLE "capacity_provider_assignments" ADD CONSTRAINT "chk_capacity_provider_assignments_lane_purpose"
	CHECK ("lane_purpose" IS NULL OR "lane_purpose" IN ('communication', 'platform', 'workday'));
ALTER TABLE "capacity_reservations" DROP CONSTRAINT IF EXISTS "chk_capacity_reservations_lane_purpose";
UPDATE "capacity_reservations" SET "lane_purpose" = 'workday' WHERE "lane_purpose" = 'operation';
ALTER TABLE "capacity_reservations" ADD CONSTRAINT "chk_capacity_reservations_lane_purpose"
	CHECK ("lane_purpose" IS NULL OR "lane_purpose" IN ('communication', 'platform', 'workday'));
ALTER TABLE "capacity_ledger_entries" DROP CONSTRAINT IF EXISTS "chk_capacity_ledger_lane_purpose";
UPDATE "capacity_ledger_entries" SET "lane_purpose" = 'workday' WHERE "lane_purpose" = 'operation';
ALTER TABLE "capacity_ledger_entries" ADD CONSTRAINT "chk_capacity_ledger_lane_purpose"
	CHECK ("lane_purpose" IS NULL OR "lane_purpose" IN ('communication', 'platform', 'workday'));
