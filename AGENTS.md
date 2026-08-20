# API agent contribution policy

Agents may populate or update the managed **Agent contribution attestation** in a pull request only when the agent definition enables delegated project authorization, the assignment and capacity grant include `contribution_attestation`, and the trusted API supplies a valid project authorization receipt bound to the exact repository, agent, provider, assignment, base SHA, and head SHA.

Agents must never check or edit the **Human contribution affirmation**. Agents may not create, broaden, renew, revoke, or supersede project contribution authorizations. Missing, stale, mismatched, expired, or revoked authority fails closed and requires one project-level human action, never routine per-PR approval.

Keep work scoped to the API repository. Never place provider private keys, membership credentials, signing secrets, PATs, or webhook secrets in an agent checkout, PR body, operation bundle, log, or chat.
