-- 0017 may have been recorded by a guard that mistook IF for a column name.
-- Repair that state without editing historical migration contents or rows.
ALTER TABLE "treedx_commit_replications" DROP COLUMN IF EXISTS "github_ref";
ALTER TABLE "treedx_commit_replications" DROP COLUMN IF EXISTS "github_status";
ALTER TABLE "treedx_commit_replications" DROP COLUMN IF EXISTS "github_receipt_json";
