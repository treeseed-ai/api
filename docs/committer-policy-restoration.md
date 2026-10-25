# Restore the existing API committer policy

Issue #620 restores `.github/approved-committers.json` exactly from trusted original API staging commit `c8e18e22f322f33550726bfe65aa79c889307f2b`, Git blob `b1a687db754ee2fac141919e6c63052d12bf2812`. It binds `treeseed-ai/api` and already lists `adrianwebb`; no committer or license permission changes.

The maintainer explicitly authorized this restoration and Task 3B integration in the current review request. The existing authorization workflow reads the exact PR base, which currently lacks the policy. This separately reviewed, exact-byte bootstrap restoration uses that human direction and existing trusted policy, not self-authorization from a candidate's declarations. No branch protections, workflow checks, legacy branches or production channels change. Runtime PRs must refresh from the restored `origin/cordis` and pass normal base-owned authorization before merge.

Verification compares original staging and main policy blobs and bytes, parses repository/schema/user binding, and confirms the diff contains only the declared restoration/docs/changelog. Keep #620 and all migration issues open until release. Initializer prevention remains a separately reviewed follow-up.
