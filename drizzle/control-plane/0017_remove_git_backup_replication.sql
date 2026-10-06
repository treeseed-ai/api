-- Publication owns GitHub branch writes. Replication only mirrors canonical
-- content to R2; unpublished commits remain under TreeDX authoring custody.
-- This does not remove remote refs, commits, authoring records, or queued jobs.
ALTER TABLE "treedx_commit_replications"
  DROP COLUMN IF EXISTS "github_ref",
  DROP COLUMN IF EXISTS "github_status",
  DROP COLUMN IF EXISTS "github_receipt_json";
