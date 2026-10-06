-- Keep assignment provenance before removing the duplicate execution authority.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM capacity_ledger_entries ledger
    JOIN agent_mode_runs run ON run.id = ledger.mode_run_id
    WHERE ledger.assignment_id IS NOT NULL AND ledger.assignment_id <> run.provider_assignment_id
  ) OR EXISTS (
    SELECT 1 FROM capacity_usage_actuals usage
    JOIN agent_mode_runs run ON run.id = usage.mode_run_id
    WHERE usage.assignment_id IS NOT NULL AND usage.assignment_id <> run.provider_assignment_id
  ) OR EXISTS (
    SELECT 1 FROM capacity_workday_events event
    LEFT JOIN agent_mode_runs run ON run.id = event.mode_run_id
    WHERE event.mode_run_id IS NOT NULL
      AND (run.id IS NULL OR event.assignment_id IS NOT NULL AND event.assignment_id <> run.provider_assignment_id)
  ) THEN
    RAISE EXCEPTION 'retired mode-run provenance conflicts with assignment custody';
  END IF;
END $$;

UPDATE capacity_ledger_entries ledger
SET assignment_id = run.provider_assignment_id
FROM agent_mode_runs run
WHERE ledger.mode_run_id = run.id AND ledger.assignment_id IS NULL;

UPDATE capacity_usage_actuals usage
SET assignment_id = run.provider_assignment_id
FROM agent_mode_runs run
WHERE usage.mode_run_id = run.id AND usage.assignment_id IS NULL;

UPDATE capacity_workday_events event
SET assignment_id = run.provider_assignment_id
FROM agent_mode_runs run
WHERE event.mode_run_id = run.id AND event.assignment_id IS NULL;

ALTER TABLE capacity_ledger_entries DROP CONSTRAINT IF EXISTS fk_capacity_ledger_mode_run;
ALTER TABLE capacity_usage_actuals DROP CONSTRAINT IF EXISTS fk_capacity_usage_actuals_mode_run;
ALTER TABLE capacity_ledger_entries DROP COLUMN IF EXISTS mode_run_id;
ALTER TABLE capacity_usage_actuals DROP COLUMN IF EXISTS mode_run_id;
ALTER TABLE capacity_workday_events DROP COLUMN IF EXISTS mode_run_id;
DROP TABLE agent_mode_runs;
