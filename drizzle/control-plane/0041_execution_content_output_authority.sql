-- A proposal may bind one exact TreeDX content identity for an acting node.
-- The graph carries that authority to the assignment grant; result content
-- cannot substitute a generated identifier.
ALTER TABLE execution_nodes ADD COLUMN output_json text;
