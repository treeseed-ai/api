CREATE TABLE identity_login_transactions (
  client_id text NOT NULL,
  browser_hash text NOT NULL,
  state_hash text NOT NULL,
  envelope jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (client_id, browser_hash)
);
CREATE INDEX identity_login_transactions_expiry ON identity_login_transactions(client_id, expires_at);
