-- Remove two pre-release development migration names superseded by the
-- normalized living-graph migrations. Their schema effects are represented by
-- 0023_living_execution_graph.sql and 0025_living_execution_reservations.sql.
DELETE FROM treeseed_control_plane_schema_migrations
WHERE name IN (
	'0024_execution_node_demand_bridge.sql',
	'0025_direct_execution_node_admission.sql'
);
