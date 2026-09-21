-- Allocation is derived from the living graph and workday policy. Retired
-- allocation sets and decision graphs must not remain writable authorities.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM capacity_provider_assignments WHERE status IN ('pending', 'leased', 'running')) THEN
    RAISE EXCEPTION 'drain active assignments before removing retired allocation authority';
  END IF;
END $$;

-- With no executable assignment left, these rows cannot make further progress.
-- Settle the one-time architecture cutover explicitly instead of leaving the
-- API unable to start merely to call its ordinary stop operation.
UPDATE capacity_reservations
SET state = 'released',
    released_seconds = GREATEST(released_seconds, reserved_seconds - active_seconds),
    updated_at = CURRENT_TIMESTAMP::text
WHERE state IN ('reserved', 'consuming', 'continuation_required')
  AND work_day_id IN (
    SELECT id FROM capacity_workday_runs WHERE status IN ('queued', 'running', 'degraded')
  );

UPDATE capacity_workday_runs
SET status = 'cancelled',
    completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP::text),
    updated_at = CURRENT_TIMESTAMP::text,
    error_json = '{"code":"architecture_contract_cutover"}'
WHERE status IN ('queued', 'running', 'degraded');

ALTER TABLE capacity_provider_assignments DROP CONSTRAINT IF EXISTS fk_capacity_provider_assignments_allocation;
ALTER TABLE capacity_reservations DROP CONSTRAINT IF EXISTS fk_capacity_reservations_allocation;
ALTER TABLE capacity_reservations DROP CONSTRAINT IF EXISTS chk_capacity_reservations_allocation_version;

ALTER TABLE capacity_provider_assignments DROP COLUMN allocation_set_id;
ALTER TABLE capacity_reservations DROP COLUMN allocation_set_id;
ALTER TABLE capacity_reservations DROP COLUMN allocation_version;
ALTER TABLE capacity_reservations DROP COLUMN allocation_slice_ids_json;

DROP TABLE decision_assignment_graphs;
DROP TABLE capacity_allocation_sets;
