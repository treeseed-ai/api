-- Historical pre-living-graph assignments can retain a retired synthesis label.
-- They have no living-graph provenance; preserve the assignment and mark that
-- single provenance field unknown so current read-back can validate honestly.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM capacity_provider_assignments
    WHERE synthesized_from IS NOT NULL
      AND synthesized_from <> 'living_execution_graph'
      AND status IN ('pending', 'leased', 'running')) THEN
    RAISE EXCEPTION 'Drain active retired-synthesis assignments before provenance migration';
  END IF;
END $$;

UPDATE capacity_provider_assignments
SET synthesized_from = NULL
WHERE synthesized_from IS NOT NULL
  AND synthesized_from <> 'living_execution_graph';
