-- The immutable assignment attempt is the sole execution input authority.
ALTER TABLE capacity_provider_assignments DROP COLUMN IF EXISTS decision_input_json;
