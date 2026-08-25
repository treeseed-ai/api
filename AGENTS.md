# API workspace guidance

The API is offered under AGPL-3.0-only and an alternative commercial license. Contributor authorization is repository policy, not assignment authority: the trusted base workflow compares the provider-authenticated pull-request author login with `.github/approved-committers.json`.

Agents operating through an approved GitHub account inherit that provider-authenticated username for this check. They must not spoof identity through email, commit metadata, or pull-request text, and must never receive GitHub tokens inside execution workspaces. Adding or removing a username requires an explicit policy assignment and reviewed commit. An unlisted account follows `.github/COMMITTER_APPROVAL.md` once; there is no per-PR grant checkbox or agent attestation.

Preserve exact project, assignment, repository, base, head, verification, review, staging, and release authority independently of committer approval.

## Project library

Use `trsd library show api` and `status` before querying `treeseed-ai/api-library`. Read root-level paths with `trsd library read api <path> --ref <exact-commit>`. Author only through governed library workspaces and reviews. Never recreate `src/content` or edit `.treeseed/data` directly.
