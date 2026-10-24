# Cordis Api


## Task 3B: Installed API root and container provider

Legacy src/api/support/server.ts remains this repository's capability. ApiApplication is the default native Cordis root, mounting selected HTTP, operation/worker, Identity and Admin class plugins. Its container provider is also a native class plugin in the host-worker context, with actual server/assets readiness. GET /health/ready is a bounded readiness endpoint; authenticated GET /v1/platform/status and /v1/platform/applications/{id} invoke the public Deployment worker client. Admin/OIDC and /identity routing terminate at the owned HTTPS edge. Local worker authority never arrives in ordinary user input. The API gets only the private worker socket directory, never Docker.sock. The package retains AGPL-3.0 licensing.

Task 3B is authorized after the maintainer reviewed the isolated setup. Tracking: #617. Detailed integration plan: https://github.com/treeseed-ai/platform/blob/feature/713-task3b-initialization/docs/superpowers/plans/2026-10-24-task3b-installed-composition.md. Implementation evidence is recorded separately; these requirements are not a passing-test claim.

Development: Bun 1.4.4, Node 24.19.0, TypeScript 5.9.3, native Cordis 4.0.0-rc.12. Run bun run verify (semantic class/source check, strict compiler, build and nonempty unit/integration/program smoke). Installed acceptance uses genuine exact package/OCI bytes, real identity/database/API/HTTPS and explicit isolated certificate trust. No global trust mutation or legacy service changes. All handwritten source, tools and tests are strict TypeScript classes.

All capabilities that can be plugins, including container services, are native Cordis class plugins with typed swappable contracts. No parallel DI graph. Keep independent repository/public package boundaries, exact archive pins and original licenses. Migration PRs target cordis with Part of issue references. All issues remain open until authorized release; installer/Agent/generalized recovery are later tasks.
