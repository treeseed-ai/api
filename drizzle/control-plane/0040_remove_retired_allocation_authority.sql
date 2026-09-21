-- Allocation is derived from the living graph and workday policy. Retired
-- allocation sets and decision graphs must not remain writable authorities.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM capacity_workday_runs WHERE status IN ('queued', 'running', 'degraded')) THEN
    RAISE EXCEPTION 'drain active workdays before removing retired allocation authority';
  END IF;
  IF EXISTS (SELECT 1 FROM capacity_provider_assignments WHERE status IN ('pending', 'leased', 'running')) THEN
    RAISE EXCEPTION 'drain active assignments before removing retired allocation authority';
  END IF;
END $$;

ALTER TABLE capacity_provider_assignments DROP CONSTRAINT IF EXISTS fk_capacity_provider_assignments_allocation;
ALTER TABLE capacity_reservations DROP CONSTRAINT IF EXISTS fk_capacity_reservations_allocation;
ALTER TABLE capacity_reservations DROP CONSTRAINT IF EXISTS chk_capacity_reservations_allocation_version;

ALTER TABLE capacity_provider_assignments DROP COLUMN allocation_set_id;
ALTER TABLE capacity_reservations DROP COLUMN allocation_set_id;
ALTER TABLE capacity_reservations DROP COLUMN allocation_version;
ALTER TABLE capacity_reservations DROP COLUMN allocation_slice_ids_json;

DROP TABLE decision_assignment_graphs;
DROP TABLE capacity_allocation_sets;
