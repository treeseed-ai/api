# Cordis Api


## Task 3B: Installed API root and container provider

Legacy src/api/support/server.ts remains this repository's capability. ApiApplication is the default native Cordis root, mounting selected HTTP, operation/worker, Identity and Admin class plugins. Its container provider is also a native class plugin in the host-worker context, with actual server/assets readiness. GET /health/ready is a bounded readiness endpoint; authenticated GET /v1/platform/status and /v1/platform/applications/{id} invoke the public Deployment worker client. Admin/OIDC and /identity routing terminate at the owned HTTPS edge. Local worker authority never arrives in ordinary user input. The API gets only the private worker socket directory, never Docker.sock. The package retains AGPL-3.0 licensing.

Task 3B is authorized after the maintainer reviewed the isolated setup. Tracking: #617. Detailed integration plan: https://github.com/treeseed-ai/platform/blob/cordis/docs/superpowers/plans/2026-10-24-task3b-installed-composition.md. Implementation evidence is recorded separately; these requirements are not a passing-test claim.

Development: Bun 1.4.4, Node 24.19.0, TypeScript 5.9.3, native Cordis 4.0.0-rc.12. Run bun run verify (semantic class/source check, strict compiler, build and nonempty unit/integration/program smoke). Installed acceptance uses genuine exact package/OCI bytes, real identity/database/API/HTTPS and explicit isolated certificate trust. No global trust mutation or legacy service changes. All handwritten source, tools and tests are strict TypeScript classes.

All capabilities that can be plugins, including container services, are native Cordis class plugins with typed swappable contracts. No parallel DI graph. Keep independent repository/public package boundaries, exact archive pins and original licenses. Migration PRs target cordis with Part of issue references. All issues remain open until authorized release; installer/Agent/generalized recovery are later tasks.

Delivery is split into two reviewable changes under #617: the native container provider/service definition baseline, then the API server root and authenticated installed interfaces. Each targets cordis and carries its own checks. The server follow-up consumes the first slice and the exact Identity, Admin and Deployment archives. This baseline does not claim an implemented server.

## Server follow-up contract

The next slice adds ApiApplication.start/close with the actual native api.host, platform.invoker, api.routes and api.http providers. Identity supplies OIDC/principal/session providers; Admin supplies its route/browser contribution. Each HTTP request receives a native isolated identity.principal child; ordinary headers/body fields never become trusted authority. The public DeploymentWorkerClient is the only host transport and API has no Docker socket/controller. GET /v1/platform, /v1/platform/status and /v1/platform/applications/{id} require the configured session and platform.read. Other declared seven-operation surfaces report unavailable explicitly in this slice. GET /health/ready reports component/context readiness; installed overall readiness comes from the worker. The owner build generates the image context from exact public runtime packages, without dependency execution or network builds.

An authenticated request for an unknown well-formed application ID returns HTTP 404 with the safe `APPLICATION_NOT_FOUND` code. Missing authority remains 401/403 and unavailable worker/runtime failures remain 503; responses never expose local journal paths or internal exception details.
