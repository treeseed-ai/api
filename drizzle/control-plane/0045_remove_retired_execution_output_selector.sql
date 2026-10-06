-- Frozen assignment grants own exact writable identities. Work items and
-- execution nodes no longer carry a duplicate output selector.
ALTER TABLE execution_nodes DROP COLUMN IF EXISTS output_json;
