-- The current execution-node contract has expected and maximum seconds only.
-- Remove the retired floor from previously projected nodes before readGraph
-- decodes them with the strict SDK schema. Preserve all other estimate data.
UPDATE execution_nodes
SET estimate_json = (estimate_json::jsonb - 'minimumSeconds')::text
WHERE estimate_json IS NOT NULL
  AND jsonb_exists(estimate_json::jsonb, 'minimumSeconds');
