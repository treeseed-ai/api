# One-time AGPL committer approval

The API is offered under AGPL-3.0-only and an alternative commercial license. A contributor therefore completes one account-level approval before their pull requests can merge.

Authorization is bound only to the provider-authenticated GitHub username that opens the pull request. TreeSeed does not match email addresses, commit author strings, pull-request body claims, or agent-supplied identities.

Open the [AGPL committer approval form](https://github.com/treeseed-ai/api/issues/new?template=agpl-committer-approval.yml), enter only the GitHub username, and affirm the terms once. A maintainer adds an accepted normalized username to `.github/approved-committers.json` through a reviewed policy pull request. Future pull requests opened by that GitHub account pass without another grant checkbox.

Approval does not bypass assignment authority, exact-head verification, tests, review, staging, main, or release policy.
