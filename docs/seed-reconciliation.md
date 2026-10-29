# Seed owner-step reconciliation

This API-owned layer implements ordering and aggregate receipt semantics for #644. It consumes
the SDK's seed contracts. It is an internal coordinator capability, not a replacement for live
authority, Deployment custody, isolated artifact preparation or the public default composition.
Those adapters must pass their own production-construction and assembled gates before the
`SeedCoordinator.open` interface can be reported as implemented.

Development consumes SDK `0.0.0-cordis.19`, source
`90cf4f3cc62e166685280450c727499defd2af5b`, archive SHA-256
`93dd549c98aba180306e9b19cc1cbc37494544b2764ed341c531c9af618c6f81`.
The accepted API closure selects Identity .8, Admin .11, Deployment .79 and UI .18 with
this same SDK .19. This internal reconciliation slice must freshly verify that exact public
archive closure after syncing origin/cordis. It does not yet adopt the newer manager/worker
SDK closure or establish the default headless coordinator and real journal/authority adapters.

`SeedReconciliation.apply(plan, requestId, signal)` accepts a schema-valid saved plan whose
canonical SHA-256, excluding only `id` and `digest`, matches its identity. It validates live
authority before acquiring the single-writer journal and before every owner operation. The
journal must bind the exact plan, request and installation, publish records durably without
overwriting uncertain state, and read back every publication. Deployment owns that implementation.

Resources run in a deterministic dependency order. Independent ready resources are ordered by
key. Owner access supplies scoped leases through native Cordis; it must validate exact accepted
provider/schema/executable identities and current owner preconditions. This API layer does not
load packages, create another service registry or give resource plugins the journal writer.

Before reconciliation the coordinator durably records a step intent. Owner reconciliation is
idempotent for the exact `(installation, plan digest, request ID, resource key)` tuple. A lost
reply is retried with that same tuple after fresh admission; changing it would risk duplicate
effects. Resume revalidates even previously verified owner receipts through current read-back.
An admission failure blocks before new intent or effects. An uncertain owner result records
`recovery-required`; it cannot become completed by catching an exception. Unverified dependencies
prevent their dependants from executing. Pending, blocked and recovery states remain explicit.

Before publishing a completed aggregate, perform a fresh read-only sweep of every observed
owner receipt after all reconciliation effects. Recheck live authority and owner admission for
each lease, read back the exact record and dispose the lease. This sweep must neither repeat
reconciliation nor publish a new intent. A later resource effect that invalidates an earlier
record prevents completion and retains explicit recovery evidence. Sequential observations do
not claim a cross-owner atomic snapshot or reserve resources against later external changes.

Completion requires an exact verified receipt for every resource and successful publication,
read-back, owner-lease disposal and writer release. Invalid, stale, cross-owner or cross-plan
receipts cannot establish completion. Unknown exception messages and resource payloads never
become safe blockers. Cancellation prevents subsequent owner effects; already completed effects
are retained in linked receipts. No automatic destructive rollback or cross-owner atomicity is
claimed.

Component fixtures identify themselves as fixtures. They prove coordinator sequencing and
failure handling, not authenticated enrollment, real private storage or Kata activation. The
complete Task 3D gate must exercise the real default adapters and hosted Ubuntu Kata runtime.
Real Work/model execution remains Task 10. Every issue remains open until authorized release.
