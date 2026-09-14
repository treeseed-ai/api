-- Clean pre-launch operational model for the living execution graph.
-- TreeDX owns proposal bytes. These tables store one normalized projection and
-- immutable assignment attempts/results; there are no graph-event or receipt
-- side tables and no duplicated canonical node/edge JSON.

CREATE TABLE execution_graph_revisions (
	team_id text NOT NULL,
	revision integer NOT NULL,
	rule_revision integer NOT NULL,
	changed_source_refs_json text NOT NULL,
	graph_digest text NOT NULL,
	changes_json text NOT NULL,
	created_at text NOT NULL,
	PRIMARY KEY (team_id, revision)
);

CREATE INDEX execution_graph_revisions_cursor_idx
	ON execution_graph_revisions(team_id, revision);

CREATE TABLE execution_nodes (
	id text PRIMARY KEY NOT NULL,
	team_id text NOT NULL,
	project_id text NOT NULL,
	workday_id text,
	work_item_id text,
	kind text NOT NULL,
	pair_role text,
	source_ref_json text NOT NULL,
	authority_refs_json text DEFAULT '[]' NOT NULL,
	rule_revision integer NOT NULL,
	node_revision integer NOT NULL,
	agent_class text,
	status text NOT NULL,
	estimate_json text,
	required_capabilities_json text,
	requested_permissions_json text,
	workspace text,
	acceptance_criteria_json text,
	maximum_review_cycles integer,
	condition_json text,
	graph_revision_created integer NOT NULL,
	graph_revision_updated integer NOT NULL,
	created_at text NOT NULL,
	updated_at text NOT NULL,
	CONSTRAINT execution_node_pair_role CHECK (pair_role IS NULL OR pair_role IN ('actor','reviewer')),
	CONSTRAINT execution_node_workspace CHECK (workspace IS NULL OR workspace IN ('read-only','treedx','git'))
);

CREATE INDEX execution_nodes_team_status_idx ON execution_nodes(team_id, status, kind, agent_class);
CREATE INDEX execution_nodes_project_work_idx ON execution_nodes(team_id, project_id, work_item_id, pair_role);

CREATE TABLE execution_edges (
	id text PRIMARY KEY NOT NULL,
	team_id text NOT NULL,
	from_node_id text NOT NULL,
	to_node_id text NOT NULL,
	provenance text NOT NULL,
	source_ref_json text,
	graph_revision_created integer NOT NULL,
	graph_revision_removed integer,
	created_at text NOT NULL,
	CONSTRAINT execution_edge_provenance CHECK (provenance IN ('profile-agent','profile-event','work-item','review-pair','governance'))
);

CREATE INDEX execution_edges_target_idx ON execution_edges(team_id, to_node_id)
	WHERE graph_revision_removed IS NULL;
CREATE INDEX execution_edges_source_idx ON execution_edges(team_id, from_node_id)
	WHERE graph_revision_removed IS NULL;

ALTER TABLE capacity_provider_assignments ADD COLUMN graph_revision integer;
ALTER TABLE capacity_provider_assignments ADD COLUMN execution_node_id text;
ALTER TABLE capacity_provider_assignments ADD COLUMN execution_node_revision integer;
ALTER TABLE capacity_provider_assignments ADD COLUMN assignment_attempt_json text;
ALTER TABLE capacity_provider_assignments ADD COLUMN assignment_result_json text;

CREATE UNIQUE INDEX capacity_assignments_active_execution_node_idx
	ON capacity_provider_assignments(team_id, execution_node_id, execution_node_revision)
	WHERE execution_node_id IS NOT NULL AND status IN ('pending','leased','running');
