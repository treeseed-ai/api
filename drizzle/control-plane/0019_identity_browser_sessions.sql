CREATE TABLE identity_browser_sessions (
  session_hash text PRIMARY KEY,
  client_id text NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  envelope jsonb NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX identity_browser_sessions_expiry ON identity_browser_sessions(expires_at);
CREATE INDEX identity_browser_sessions_issuer ON identity_browser_sessions(issuer, subject);
CREATE INDEX identity_browser_sessions_user ON identity_browser_sessions(user_id);
