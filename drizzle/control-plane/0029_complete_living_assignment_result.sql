-- Complete the normalized living-assignment seam on databases that adopted an
-- earlier partial graph migration. These columns are canonical assignment
-- attempt/result state; no legacy content or planning authority is restored.
ALTER TABLE capacity_provider_assignments ADD COLUMN IF NOT EXISTS graph_revision integer;
ALTER TABLE capacity_provider_assignments ADD COLUMN IF NOT EXISTS execution_node_id text;
ALTER TABLE capacity_provider_assignments ADD COLUMN IF NOT EXISTS execution_node_revision integer;
ALTER TABLE capacity_provider_assignments ADD COLUMN IF NOT EXISTS assignment_attempt_json text;
ALTER TABLE capacity_provider_assignments ADD COLUMN IF NOT EXISTS assignment_result_json text;

CREATE UNIQUE INDEX IF NOT EXISTS capacity_assignments_active_execution_node_idx
	ON capacity_provider_assignments(team_id, execution_node_id, execution_node_revision)
	WHERE execution_node_id IS NOT NULL AND status IN ('pending','leased','running');
