# TreeDX publication and replication

Staging library changes require authorization and exact-revision validation, not
human or independent-author approval. New submissions are admitted automatically;
an authorized publisher can publish an existing submitted revision directly.
Historical editorial-review metadata does not block staging admission. The API
checks the committed workspace and atomically admits its observed version. The
runner retains immutable source, expected-head, graph, storage, and audit checks.
Direct main publication is prohibited: production promotion belongs to the
protected main pull-request boundary.

GitHub branch writes belong to governed knowledge publication. Publication uses
the repository binding's configured publication ref, checks the expected remote
head, and verifies the exact reviewed commit after pushing. Replication must not
publish drafts, force remote history, or create a GitHub branch per commit.

The commit replication outbox maintains the canonical R2 file mirror. Unpublished
commits remain in TreeDX authoring custody and are excluded from that mirror.
Their immutable refs and unpublished-work records must not be removed as a side
effect of replication. A completed non-canonical replication receipt means the
mirror was intentionally skipped, **not** that an off-host draft backup exists.
TreeDX storage backup and recovery remain separate operational responsibilities.

Migration 0017 removes the retired GitHub destination/status/receipt columns;
queued replication operations retain their IDs and continue as R2-only work.
Coordinate the API and operations-runner update with the database migration:
stop old writers before applying it, then start the updated services. An old
application requires a coordinated database restore, not a binary-only rollback.

Existing remote backup refs are not deleted by this migration. Before removing
one, prove that its exact work is integrated, explicitly superseded, or retained
in a verified recoverable backup. Do not replace the branches with per-commit
tags or push unpublished commits onto the configured publication branch.
