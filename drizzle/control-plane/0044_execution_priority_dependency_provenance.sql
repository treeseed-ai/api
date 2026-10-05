-- Keep the canonical derived node priority in the existing graph projection.
-- NULL preserves omission; ranking treats omitted priority as zero.
ALTER TABLE execution_nodes ADD COLUMN priority bigint;
ALTER TABLE execution_nodes ADD CONSTRAINT execution_node_priority
	CHECK (priority BETWEEN -9007199254740991 AND 9007199254740991);

-- Ordinary governed TreeDX dependency links use the existing edge authority.
ALTER TABLE execution_edges DROP CONSTRAINT execution_edge_provenance;
ALTER TABLE execution_edges ADD CONSTRAINT execution_edge_provenance
	CHECK (provenance IN ('profile-agent','profile-event','work-item','review-pair','governance','treedx-link'));
