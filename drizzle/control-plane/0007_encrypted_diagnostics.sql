ALTER TABLE "communication_execution_trace_events"
	ADD COLUMN IF NOT EXISTS "protected_payload_envelope_json" jsonb,
	ADD COLUMN IF NOT EXISTS "protected_payload_digest" text,
	ADD COLUMN IF NOT EXISTS "protected_payload_key_id" text,
	ADD COLUMN IF NOT EXISTS "protected_payload_key_version" integer;

CREATE INDEX IF NOT EXISTS "communication_trace_encrypted_expiry_idx"
	ON "communication_execution_trace_events" ("protected_payload_expires_at")
	WHERE "protected_payload_envelope_json" IS NOT NULL;

-- NOT VALID preserves legacy rows for the bounded application backfill while
-- immediately rejecting every new plaintext protected payload.
ALTER TABLE "communication_execution_trace_events"
	ADD CONSTRAINT "communication_trace_no_new_protected_plaintext"
	CHECK ("protected_payload_json" IS NULL) NOT VALID;
