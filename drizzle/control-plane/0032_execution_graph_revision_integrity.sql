-- Repair graph metadata damaged by concurrent reconcilers before revision
-- custody became the write guard, then make the invariant structural.
UPDATE execution_nodes
SET graph_revision_updated = graph_revision_created
WHERE graph_revision_updated < graph_revision_created;

ALTER TABLE execution_nodes
	ADD CONSTRAINT execution_node_revision_order
	CHECK (graph_revision_updated >= graph_revision_created);
