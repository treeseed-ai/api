-- A live envelope cannot be discarded while it might still admit work.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM workday_capacity_envelopes
    WHERE status IN ('draft', 'queued', 'active', 'paused')
  ) THEN
    RAISE EXCEPTION 'retired workday envelopes must be drained before migration';
  END IF;
END $$;

DROP TABLE workday_capacity_envelopes;
