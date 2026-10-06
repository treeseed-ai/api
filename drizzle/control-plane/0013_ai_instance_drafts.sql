CREATE TABLE IF NOT EXISTS team_ai_instances (
 id TEXT NOT NULL,
 team_id TEXT NOT NULL REFERENCES teams(id),
 configuration_json TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY (team_id, id)
);
