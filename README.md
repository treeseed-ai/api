# Cordis Api


## Task 3B: Installed API root and container provider

Legacy src/api/support/server.ts remains this repository's capability. ApiApplication is the default native Cordis root, mounting selected HTTP, operation/worker, Identity and Admin class plugins. Its container provider is also a native class plugin in the host-worker context, with actual server/assets readiness. GET /health/ready is a bounded readiness endpoint; authenticated GET /v1/platform/status and /v1/platform/applications/{id} invoke the public Deployment worker client. Admin/OIDC and /identity routing terminate at the owned HTTPS edge. Local worker authority never arrives in ordinary user input. The API gets only the private worker socket directory, never Docker.sock. The package retains AGPL-3.0 licensing.

Task 3B is authorized after the maintainer reviewed the isolated setup. Tracking: #617. Detailed integration plan: https://github.com/treeseed-ai/platform/blob/cordis/docs/superpowers/plans/2026-10-24-task3b-installed-composition.md. Implementation evidence is recorded separately; these requirements are not a passing-test claim.

Development: Bun 1.4.4, Node 24.19.0, TypeScript 5.9.3, native Cordis 4.0.0-rc.12. Run bun run verify (semantic class/source check, strict compiler, build and nonempty unit/integration/program smoke). Installed acceptance uses genuine exact package/OCI bytes, real identity/database/API/HTTPS and explicit isolated certificate trust. No global trust mutation or legacy service changes. All handwritten source, tools and tests are strict TypeScript classes.

All capabilities that can be plugins, including container services, are native Cordis class plugins with typed swappable contracts. No parallel DI graph. Keep independent repository/public package boundaries, exact archive pins and original licenses. Migration PRs target cordis with Part of issue references. All issues remain open until authorized release; installer/Agent/generalized recovery are later tasks.

Delivery is split into two reviewable changes under #617: the native container provider/service definition baseline, then the API server root and authenticated installed interfaces. Each targets cordis and carries its own checks. The server follow-up consumes the first slice and the exact Identity, Admin and Deployment archives. The integrated Task 3B server remains implemented; the following historical contract describes that boundary.

## Server follow-up contract

Task 3B provides ApiApplication.start/close with the actual native api.host, platform.invoker, api.routes and api.http providers. Identity supplies OIDC/principal/session providers; Admin supplies its route/browser contribution. Each HTTP request receives a native isolated identity.principal child; ordinary headers/body fields never become trusted authority. The public DeploymentWorkerClient is the only host transport and API has no Docker socket/controller. GET /v1/platform, /v1/platform/status and /v1/platform/applications/{id} require the configured session and platform.read. Other declared seven-operation surfaces report unavailable explicitly in this slice. GET /health/ready reports component/context readiness; installed overall readiness comes from the worker. The owner build generates the image context from exact public runtime packages, without dependency execution or network builds.

An authenticated request for an unknown well-formed application ID returns HTTP 404 with the safe `APPLICATION_NOT_FOUND` code. Missing authority remains 401/403 and unavailable worker/runtime failures remain 503; responses never expose local journal paths or internal exception details.

## Task 3C contract

Owner issue: https://github.com/treeseed-ai/api/issues/624. Follow the approved Platform Task 3C service/provider/UI plan through exact public archives. Preserve independent repository ownership, strict TypeScript classes, native Cordis lifecycle, historical formats and all seven SDK operations. Expected-generation/idempotency, resource/credential/TLS retention and explicit unsafe restart/migration gates are mandatory. All issues remain open until release.

Every visual component must be mobile-first from 320 CSS pixels to widescreen monitors; test 320/375/768/1024/1440/1920/2560 widths, long content, keyboard/touch and 200% text resizing. Keep authored controls at least 44×44 CSS pixels, required actions visible, logical/fluid dimensions and no page overflow (labeled local semantic-table overflow is permitted). UI owns components/styles/renderers; consumers retain domain behavior and Identity retains Keycloak authority.


### Native format-3 root and installed runtime evidence

Task 3C advances the API root's api.host, platform.invoker, api.routes and api.http contracts to
native provider version 4, consuming exact SDK/Deployment/Identity/Admin/UI archives. Identity owns
Keycloak discovery, principals and sessions; Admin owns authorized HTTP/actions; UI supplies every
rendered component/document/asset. The seven public SDK operation IDs and current authenticated
read endpoints remain unchanged. Unsupported operations continue to fail explicitly.

The private server configuration extends the existing fields with a paired `serviceId` and
`runtimeReceipt` for format 3. Identity/Admin receive only their existing configuration projection.
The private worker adapter uses observer-only `ServiceWorkerClient` through `/run/cordis-host/host.sock`,
never owner control or Docker.sock. Initialization reads accepted `observation.context` metadata
instead of recursively asking overall status to prove API startup. Bind installation/service IDs,
origin, asset generation and exact runtime content before opening the listener. Historical format-2
archives/readers remain immutable; new mode cannot silently adopt incompatible journals.

`NodeApiServicePlugin` declares its container, typed `platform.api@1.0.0` binding, dependencies and
credential slots in this repository. No literal database/identity service IDs are embedded in its
configuration; selected typed endpoints and grants resolve them. Only an explicit profile grant may
mount the observer directory, with installation-owner UID and read-only socket-directory access.
`ApiReadinessPlugin` owns API-specific direct HTTP and routed HTTPS health/asset qualification. Its
protocol uses Deployment's bounded byte transport; generic Deployment code gains no API role switch.
Routed observation targets the explicitly bound API dependency and its accepted expected identity.

The owner image producer retains exact public runtime archives, their complete locked closure and
installed file identities. Runtime audit inspects archives through the Deployment public artifact
interface and compares actual installed bytes, server entry and complete Admin/UI asset generation.
Match measured package-set/entry digests to accepted runtime bindings before reporting readiness.
Copying expected labels or receipt hashes into a response is insufficient. Host verification retains
image/daemon authority; API reports measured runtime content and actual native provider generation.

Built default-root acceptance must run genuine package/image bytes with real database, Keycloak,
private worker and HTTP listener, plus direct/routed observations. Tampered archives, installed files,
entry/assets, wrong identity/generation, foreign grants and denied socket mounts must block. Preserve
session/Origin/CSRF/PKCE/CSP boundaries, immutable browser assets and reusable mobile-first UI. The
restored #620 committer policy remains exact; all issues remain open. This documentation commits the
contract before implementation and does not claim those new assembled gates have passed.

### Exact Task 3C dependency candidates

Native-root work consumes these private review archives through public exports. This is an
in-progress adoption receipt, not a passing API runtime/assembly claim:

| Owner | Version | Source commit | Archive SHA-256 |
| --- | --- | --- | --- |
| SDK | `0.0.0-cordis.12` | `4a0b12ca45478f58d92a02de4a7c144ed94c7417` | `9652a1e1f830eb85c41b2d9ea207782ffdf291db2ef97331e338775dadf62fd4` |
| Deployment | `0.0.0-cordis.33` | `4e5f19cf55cdd9c7d7ee679b5d3f451334b1d4ee` | `34b9f1080fc5a86a3c193daf5039537b91f4947514b84c9603268183b2bf42b1` |
| Identity | `0.0.0-cordis.4` | `d837d23d99bc49eb1954bdd865397d34186d41a1` | `0e377e4a0ad79ee649b20e41779c862e431f20979b19cae638b658925686d9f1` |
| Admin | `0.0.0-cordis.6` | `e3155dc389080d1c48370a3057660ad97e4a7404` | `98e709ade2c8cda1913f5c65c995334a97056fd5b9d60e78a6261e110576dd1c` |
| UI | `0.0.0-cordis.14` | `a0f28a2d4a3285cbb5203a97c2cdb620517871ae` | `6c1032996990178f7a76d5cbde2e15a4b6467941159d6d6013a33526e799e7ad` |

API keeps AGPL-3.0 licensing, the restored committer policy and its own source/image producer.
No cross-checkout source imports or production publication are introduced.

The installed-root acceptance fixture prepares its bundle before planning: pack this API's built
program, consume the exact vendored owner archives and acquire registry archives only at the
versions and SRI identities pinned in this owner's lock. No registry request, install, build or
lifecycle script runs during plan/apply. The genuine database, Keycloak and edge images remain
separate package-owned plugins. Fixture image production uses this API's public image-context
interface; recipe materialization and host operations use Deployment's public interfaces.
CI must run the installed-root gate on Ubuntu 26.04 and fail visibly on missing prerequisites.

The updated owner selections qualify the granted observer mount and public recipe projection in
Deployment, remove Identity's fixed internal service alias/port and rebuild Admin against that
exact identity candidate. API's genuine installed-root gate is in progress; no successful API
activation or completed Task 3C acceptance is claimed by these dependency pins.

Runtime auditing pins ancestor directory identity/ownership/permissions and reads files through
retained descriptors. Changes to unrelated sibling files are not runtime content changes;
ancestor directory entry counts and timestamps are excluded from content identity. Audited file
bytes, inode, size and change timestamps remain strict, and the installed package/archive trees
still reject unexpected files and symlinks.
