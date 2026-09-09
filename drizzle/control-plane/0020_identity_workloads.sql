-- Explicit application-owned workload registrations. No shared secrets or
-- provider enrollment permissions are inferred from a successful OIDC login.
CREATE TABLE identity_workloads (
  id text PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  client_id text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  permissions jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(permissions) = 'array'),
  scopes jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(scopes) = 'array'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (issuer, subject)
);
