CREATE TABLE IF NOT EXISTS "capability_ontology_generations" (
  "generation" integer PRIMARY KEY,
  "ontology_digest" text NOT NULL UNIQUE,
  "status" text NOT NULL,
  "signature_json" text NOT NULL,
  "created_at" text NOT NULL,
  CONSTRAINT "chk_capability_ontology_status" CHECK ("status" IN ('active','superseded'))
);

CREATE TABLE IF NOT EXISTS "capability_definitions" (
  "capability_id" text NOT NULL,
  "version" text NOT NULL,
  "definition_digest" text NOT NULL,
  "generation" integer NOT NULL REFERENCES "capability_ontology_generations"("generation") ON DELETE restrict,
  "namespace" text NOT NULL,
  "family" text NOT NULL,
  "status" text NOT NULL,
  "definition_json" text NOT NULL,
  "created_at" text NOT NULL,
  PRIMARY KEY ("capability_id","version","generation")
);

CREATE TABLE IF NOT EXISTS "provider_capability_proposals" (
  "id" text PRIMARY KEY,
  "capacity_provider_id" text NOT NULL REFERENCES "capacity_providers"("id") ON DELETE cascade,
  "capability_id" text NOT NULL,
  "version" text NOT NULL,
  "definition_digest" text NOT NULL,
  "status" text NOT NULL,
  "definition_json" text NOT NULL,
  "signature_json" text NOT NULL,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  UNIQUE ("capacity_provider_id","capability_id","version","definition_digest")
);

CREATE TABLE IF NOT EXISTS "execution_capability_offers" (
  "capacity_provider_id" text NOT NULL REFERENCES "capacity_providers"("id") ON DELETE cascade,
  "execution_provider_id" text NOT NULL,
  "offer_id" text NOT NULL,
  "offer_digest" text NOT NULL,
  "offer_json" text NOT NULL,
  "status" text NOT NULL,
  "last_seen_at" text NOT NULL,
  PRIMARY KEY ("capacity_provider_id","offer_id")
);

CREATE TABLE IF NOT EXISTS "capability_negotiation_receipts" (
  "id" text PRIMARY KEY,
  "team_id" text NOT NULL REFERENCES "teams"("id") ON DELETE cascade,
  "assignment_id" text,
  "demand_digest" text NOT NULL,
  "offer_digest" text NOT NULL,
  "receipt_json" text NOT NULL,
  "created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_capability_definitions_active" ON "capability_definitions" ("generation","family","status","capability_id");
CREATE INDEX IF NOT EXISTS "idx_provider_capability_proposals_status" ON "provider_capability_proposals" ("status","created_at");
CREATE INDEX IF NOT EXISTS "idx_execution_capability_offers_status" ON "execution_capability_offers" ("status","last_seen_at");
