-- Earlier pre-release development projections created execution_edges before
-- the normalized graph contract added retirement revisions. Fresh databases
-- already have this column through 0023_living_execution_graph.sql.
ALTER TABLE execution_edges ADD COLUMN graph_revision_removed integer;

CREATE INDEX IF NOT EXISTS execution_edges_target_idx
	ON execution_edges(team_id, to_node_id)
	WHERE graph_revision_removed IS NULL;

CREATE INDEX IF NOT EXISTS execution_edges_source_idx
	ON execution_edges(team_id, from_node_id)
	WHERE graph_revision_removed IS NULL;
