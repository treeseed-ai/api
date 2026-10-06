CREATE TABLE IF NOT EXISTS team_ai_storage_bindings (
 team_id TEXT NOT NULL,
 node_id TEXT NOT NULL,
 connection_id TEXT NOT NULL REFERENCES team_service_connections(id),
 bucket TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
 status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
 issuance_window BIGINT NOT NULL DEFAULT 0,
 issuance_count INTEGER NOT NULL DEFAULT 0 CHECK (issuance_count >= 0 AND issuance_count <= 120),
 updated_at TEXT NOT NULL,
 PRIMARY KEY (team_id, node_id),
 FOREIGN KEY (team_id, node_id) REFERENCES team_ai_instances(team_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS ai_storage_proof_nonces (
 node_id TEXT NOT NULL,
 nonce TEXT NOT NULL,
 expires_at BIGINT NOT NULL,
 PRIMARY KEY (node_id, nonce)
);
CREATE INDEX IF NOT EXISTS ai_storage_proof_expiry ON ai_storage_proof_nonces(expires_at);
