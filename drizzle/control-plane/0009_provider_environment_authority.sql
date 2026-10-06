CREATE TABLE IF NOT EXISTS "capacity_provider_environment_profiles" (
  "capacity_provider_id" text NOT NULL REFERENCES "capacity_providers"("id") ON DELETE cascade,
  "profile_id" text NOT NULL,
  "generation" integer NOT NULL,
  "descriptor_json" text NOT NULL,
  "updated_at" text NOT NULL,
  PRIMARY KEY ("capacity_provider_id","profile_id"),
  CONSTRAINT "chk_capacity_provider_environment_profiles_generation" CHECK ("generation" >= 1)
);

CREATE TABLE IF NOT EXISTS "capacity_assignment_environment_grants" (
  "assignment_id" text PRIMARY KEY REFERENCES "capacity_provider_assignments"("id") ON DELETE cascade,
  "grant_id" text NOT NULL UNIQUE,
  "team_id" text NOT NULL REFERENCES "teams"("id") ON DELETE cascade,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE restrict,
  "capacity_provider_id" text NOT NULL REFERENCES "capacity_providers"("id") ON DELETE restrict,
  "profile_id" text NOT NULL,
  "grant_json" text NOT NULL,
  "issued_at" text NOT NULL,
  "expires_at" text NOT NULL,
  "revoked_at" text,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  FOREIGN KEY ("capacity_provider_id","profile_id") REFERENCES "capacity_provider_environment_profiles"("capacity_provider_id","profile_id") ON DELETE restrict
);

CREATE INDEX IF NOT EXISTS "idx_capacity_provider_environment_profiles_updated" ON "capacity_provider_environment_profiles" ("capacity_provider_id","updated_at","profile_id");
CREATE INDEX IF NOT EXISTS "idx_capacity_assignment_environment_grants_provider" ON "capacity_assignment_environment_grants" ("capacity_provider_id","expires_at","revoked_at");
