# API workspace guidance

The API is offered under AGPL-3.0-only and an alternative commercial license. Contributor authorization is repository policy, not assignment authority: the trusted base workflow compares the provider-authenticated pull-request author login with `.github/approved-committers.json`.

Agents operating through an approved GitHub account inherit that provider-authenticated username for this check. They must not spoof identity through email, commit metadata, or pull-request text, and must never receive GitHub tokens inside execution workspaces. Adding or removing a username requires an explicit policy assignment and reviewed commit. An unlisted account follows `.github/COMMITTER_APPROVAL.md` once; there is no per-PR grant checkbox or agent attestation.

Preserve exact project, assignment, repository, base, head, verification, review, staging, and release authority independently of committer approval.

## Branch and deployment boundary

`main` is the only production branch and maps only to the `production` deployment environment. `staging` is the only development-integration branch and maps only to the `staging` deployment environment. Short-lived pull-request branches may validate without deploying, but they must never define another deployment environment. Do not create or use `development`, `preview`, `stable`, or any other GitHub deployment environment; preview deployments are prohibited. Release tags may promote an exact reviewed `staging` commit to `production` without creating another branch or environment. Artifact channel names must never become GitHub deployment environments.

## Project library

Use `trsd library show api` and `status` before querying `treeseed-ai/api-library`. Read root-level paths with `trsd library read api <path> --ref <exact-commit>`. Author only through governed library workspaces and reviews. Never recreate `src/content` or edit `.treeseed/data` directly.
