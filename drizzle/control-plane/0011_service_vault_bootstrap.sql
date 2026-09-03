
CREATE TABLE IF NOT EXISTS "user_service_vault_keys" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "public_key" text NOT NULL,
  "encrypted_private_key_envelope_json" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  CONSTRAINT "user_service_vault_keys_user_unique" UNIQUE("user_id"),
  CONSTRAINT "chk_user_service_vault_keys_version" CHECK ("version" >= 1)
);

CREATE TABLE IF NOT EXISTS "team_service_vaults" (
  "team_id" text PRIMARY KEY NOT NULL REFERENCES "teams"("id") ON DELETE cascade,
  "encryption_version" text NOT NULL,
  "active_key_version" integer NOT NULL DEFAULT 1,
  "created_by_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE restrict,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  CONSTRAINT "chk_team_service_vaults_key_version" CHECK ("active_key_version" >= 1)
);

CREATE TABLE IF NOT EXISTS "team_service_vault_grants" (
  "id" text PRIMARY KEY NOT NULL,
  "team_id" text NOT NULL REFERENCES "teams"("id") ON DELETE cascade,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "user_vault_key_id" text NOT NULL REFERENCES "user_service_vault_keys"("id") ON DELETE cascade,
  "key_version" integer NOT NULL,
  "wrapped_team_vault_key" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  CONSTRAINT "team_service_vault_grants_version_unique" UNIQUE("team_id","user_id","key_version"),
  CONSTRAINT "chk_team_service_vault_grants_status" CHECK ("status" IN ('active','revoked','superseded'))
);

CREATE TABLE IF NOT EXISTS "team_service_credential_envelopes" (
  "id" text PRIMARY KEY NOT NULL,
  "team_id" text NOT NULL REFERENCES "teams"("id") ON DELETE cascade,
  "connection_id" text NOT NULL REFERENCES "team_service_connections"("id") ON DELETE cascade,
  "credential_profile_id" text NOT NULL REFERENCES "team_service_credential_profiles"("id") ON DELETE cascade,
  "field_key" text NOT NULL,
  "key_version" integer NOT NULL,
  "envelope_json" text NOT NULL,
  "fingerprint" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  CONSTRAINT "team_service_credential_envelopes_field_unique" UNIQUE("connection_id","credential_profile_id","field_key"),
  CONSTRAINT "chk_team_service_credential_envelopes_status" CHECK ("status" IN ('active','superseded'))
);

CREATE TABLE IF NOT EXISTS "service_operation_leases" (
  "id" text PRIMARY KEY NOT NULL,
  "team_id" text NOT NULL REFERENCES "teams"("id") ON DELETE cascade,
  "connection_id" text NOT NULL REFERENCES "team_service_connections"("id") ON DELETE cascade,
  "capability_type" text NOT NULL,
  "purpose" text NOT NULL,
  "resource_scope_json" text NOT NULL DEFAULT '{}',
  "credential_profile_id" text NOT NULL,
  "actor_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE restrict,
  "required_fields_json" text NOT NULL,
  "public_key" text,
  "sealed_payload" text,
  "status" text NOT NULL DEFAULT 'awaiting-runner',
  "expires_at" text NOT NULL,
  "consumed_at" text,
  "operation_correlation_id" text NOT NULL,
  "hosted_binding_json" text,
  "authority_requests_json" text,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  CONSTRAINT "chk_service_operation_leases_status" CHECK ("status" IN ('awaiting-runner','pending','ready','consumed','expired','cancelled','failed'))
);

CREATE INDEX IF NOT EXISTS "idx_team_service_vault_grants_active" ON "team_service_vault_grants" ("team_id","user_id","status","key_version");
CREATE INDEX IF NOT EXISTS "idx_team_service_credential_envelopes_connection" ON "team_service_credential_envelopes" ("team_id","connection_id","status");
CREATE INDEX IF NOT EXISTS "idx_service_operation_leases_runner" ON "service_operation_leases" ("status","expires_at","created_at");

