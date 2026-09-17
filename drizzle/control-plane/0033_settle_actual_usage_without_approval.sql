-- Limits constrain admission, not truthful reporting of terminal consumption.
-- Keep actual commitments above the cap so later releases cannot erase overuse.
ALTER TABLE capacity_admission_counters
  DROP CONSTRAINT chk_capacity_admission_counter_committed_amount;
--> statement-breakpoint
ALTER TABLE capacity_admission_counters
  ADD CONSTRAINT chk_capacity_admission_counter_committed_amount
  CHECK (committed_amount >= 0);
