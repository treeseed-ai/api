-- Living execution reservations bind directly to an immutable assignment/node.
-- Allocation-set and grant columns remain nullable only until the retired
-- scheduler tables and callers are deleted in the coordinated schema cutover.
ALTER TABLE capacity_reservations ALTER COLUMN admission_token DROP NOT NULL;
ALTER TABLE capacity_reservations ALTER COLUMN grant_id DROP NOT NULL;
ALTER TABLE capacity_reservations ALTER COLUMN allocation_set_id DROP NOT NULL;
ALTER TABLE capacity_reservations ALTER COLUMN allocation_version DROP NOT NULL;
ALTER TABLE capacity_reservations DROP CONSTRAINT IF EXISTS chk_capacity_reservations_allocation_version;
ALTER TABLE capacity_reservations ADD CONSTRAINT chk_capacity_reservations_allocation_version
  CHECK (allocation_version IS NULL OR allocation_version >= 1);
