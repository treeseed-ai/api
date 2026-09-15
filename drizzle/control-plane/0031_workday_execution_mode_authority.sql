ALTER TABLE "capacity_workday_runs"
  ADD COLUMN "execution_mode" text;

UPDATE "capacity_workday_runs"
SET "execution_mode" = CASE
  WHEN "parameters_json"::jsonb->>'executionMode' = 'production' THEN 'production'
  ELSE 'simulation'
END;

ALTER TABLE "capacity_workday_runs"
  ALTER COLUMN "execution_mode" SET NOT NULL;

ALTER TABLE "capacity_workday_runs"
  ADD CONSTRAINT "chk_capacity_workday_runs_execution_mode"
  CHECK ("execution_mode" IN ('simulation', 'production'));

UPDATE "capacity_workday_runs"
SET "parameters_json" = ("parameters_json"::jsonb - 'executionMode')::text
WHERE jsonb_exists("parameters_json"::jsonb, 'executionMode');
