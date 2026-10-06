CREATE TABLE provider_source_candidates (
  id text PRIMARY KEY,
  team_id text NOT NULL,
  project_id text NOT NULL,
  assignment_id text NOT NULL,
  provider_id text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  state text NOT NULL CHECK (state IN ('uploading', 'accepted', 'quarantined')),
  attestation_json jsonb NOT NULL,
  signature_json jsonb NOT NULL,
  receipt_json jsonb,
  created_at timestamptz NOT NULL,
  accepted_at timestamptz,
  UNIQUE (assignment_id, attempt)
);
CREATE INDEX provider_source_candidates_project ON provider_source_candidates(team_id, project_id, state);
