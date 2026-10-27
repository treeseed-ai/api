# Cordis Api

## Headless seed coordination

Implementation contract under #644; this section is not a passing-runtime claim. API owns the
legacy seed-operation capability and its successor reconciliation semantics. The successor is a
public `@treeseed-cordis/api/seeds` package entry. CLI uses it without constructing `ApiApplication`,
opening an HTTP listener, starting an API server or acquiring browser identity state. Existing
HTTP endpoints and the seven global platform operations remain unchanged.

`SeedCoordinator.open(selection)` opens a process-local native Cordis root for one explicit
installation, project and platform profile. Selection contains no caller-asserted authority.
The selected identity/authority adapter resolves live authorization through its public owner
boundary. Missing configuration, an ambiguous provider or an incompatible selection blocks;
there is no account, installation or credential fallback.

The coordinator exposes these asynchronous methods and `close()`:

| Method | Result and effect |
|---|---|
| `validate(bundle, signal)` | Validate the versioned envelope, prepare accepted validators and report safe blockers. No live resource activation. |
| `plan(bundle, signal)` | Resolve exact artifacts, validate resources/dependencies/preconditions and save/read back an unblocked SDK `SeedPlan`. |
| `apply(planReference, requestId, signal)` | Recheck the saved plan and authority, reconcile admitted owner steps and return an SDK `SeedReceipt`. |
| `show(reference, signal)` | Read a saved exact plan or receipt through private custody. No bundle reacquisition or activation. |
| `verify(receiptReference, signal)` | Recheck live authority and owner read-back; stale records cannot establish current readiness. |

Native plugins provide typed `seed.coordinator`, `seed.authority`, `seed.artifacts`,
`seed.preparation`, `seed.resources` and `seed.journal` capabilities. The typed service locator
uses native Cordis resolution; metadata describing resource kinds is not an instance cache or
another dependency container. Resource providers remain in their owning packages. SDK owns
portable schemas, inferred types and provider/client contracts. API owns ordering, authority
admission, idempotent reconciliation and aggregate receipt semantics.

Deployment supplies common accepted NPM/Git acquisition and descriptor-anchored private custody.
Only the trusted coordinator can write `.cordis/seeds`; a resource plugin cannot receive its
writer capability. Accepted validators run in disposable restricted preparation scopes with no
writable live installation, credentials or host-control socket. Cordis contexts are not isolation.
Seed planning may run those preparation containers but never starts managed services, activates
providers or changes the existing non-activating `platform plan` behavior.

The journal binds exact seed/schema/executable/artifact identities, selected project/profile,
trusted authority, resource owners and expected/desired generations. Apply holds one writer,
rechecks authority and owner preconditions before each effect, and links verified owner receipts.
Lost replies require exact read-back. Resume retains resolved artifacts and verified steps.
Partial, pending, blocked and recovery-required are explicit; no cross-owner atomicity or
destructive automatic rollback is promised. A downloaded plugin is not an active capability.

Initial resource providers cover host composition, plugin selection, capacity-provider
configuration, Agent definitions and environments. Agent owns manager, worker, profiles, warm
pool and guest execution. Deployment owns bounded sandbox operations. Existing teams enroll
through the existing public control plane and Keycloak-governed approval; seeds cannot grant
their own team access. Team/project/repository migration and productive Work/model execution
remain deferred to their owner tasks and Task 10.

Default construction, a genuine packed Node consumer and owner tests in the four test tiers
must verify these interfaces. Fixtures may substitute transport endpoints, never identity
authority or production services. The exact #620 approved-committers blob and AGPL license
remain unchanged. All issues, including Platform #678, stay open until authorized release.


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
| sdk | `0.0.0-cordis.16` | `4c0ecd2a0fc28545dbf677cc988ce69f0cf2f15d` | `4084aa8dbe9767984fac9fef7f5cea30a0bec93ed416138d32c804e6389fdba5` |
| deployment | `0.0.0-cordis.73` | `5cc3f3cc655ae318d195746ad3c85a2742bd3c6c` | `3fdcdcf0199aa82c2fc30cf5ff95c0b9dce49f138764366fb99638d10b087576` |
| identity | `0.0.0-cordis.7` | `f29824578d0aa8fc7725a195b72c698b476da429` | `90ac95f3e1d953f0aeddb5d0da01e9e596b226bbbc806bff3566d274a34f22d6` |
| admin | `0.0.0-cordis.10` | `227011825a885f184f1b2540d72d830a905ba8a2` | `4891b1e51515ae79827ae801cc14abad4e7b66f3cd6d924860113e934c92cfe5` |
| ui | `0.0.0-cordis.16` | `32f16876aa6f0eb1f99a4ab339296609c830df23` | `0251c6ff1f5c4b6a628d85113d1e10b9ab019f26d1dda38c7aad3c12f84ef571` |

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

The authenticated application read endpoint preserves the SDK's public application DTO.
Format-3 private worker records are projected to its declared fields before response validation;
plan digests, idempotency keys, private sequence/format metadata and acknowledgements do not
become extra HTTP fields. Legacy public DTOs retain the same shape. Full private read-back stays
on the installation's owner/observer boundary.

The genuine installed-root continuation adopts Admin `.7` from
`45abbeeb5e99f368128418168d913a30721fefba`, archive SHA-256
`2041d42294bcd5814dc0a481bcc5a95b583ca4ba2a201b46d72a8f0c57979132`.
Its asset catalog resolves named package roots across Node's nested module-mode boundaries.
The API consumes that public owner fix; it does not duplicate Admin asset resolution.

### Genuine installed identity and reusable browser acceptance

The installed-root gate signs in through genuine Keycloak over the selected public HTTPS
origin using only the disposable fixture's private bootstrap credential. A fresh Firefox
profile trusts only the fixture's exported Caddy CA; TLS bypass is forbidden. It verifies
Admin's reusable mobile-first controls, authenticated status and application read-back through
the seven-operation SDK contract, Origin/CSRF refusals, session-cookie protections and logout
revocation. Credentials and cookies never enter fixture output. The gate retains the native
worker and compares resource/credential/TLS identity before and after reads and browser actions.
This is test-only activation of uniquely scoped disposable resources, not a user installation.

The target-evidence continuation adopts Deployment `.35` from
`24ec538241217a9aec3075b94d299aa21c8061dc`, archive SHA-256
`2e648ca3dd8f67de107692975efbd62cd1227667d386faf0120d39e9ac4fdc58`.
The genuine four-service test reached running containers but failed snapshot publication
because direct and routed API observations shared one target. Deployment now admits identical
evidence once and blocks conflicting observations; API retains its owning semantic probes.
Qualification of the new assembled candidate remains required.

The SDK status-contract continuation adopts Admin `.8` from
`83b9bd399666bcaa0d806b807804f4a8b7b3514e`, archive SHA-256
`6ed661574bbe10f00dfa09fafc84c60785e987152cd997ecb31395334077c4a2`.
Admin now validates the native invoker's raw SDK status result. API machine endpoints retain
their established raw operation outputs; CLI envelopes do not redefine those outputs.
Browser acceptance checks the same SDK projections and revocation of the exact prior cookie.

## Final Task 3C owner closure

The current API review candidate consumes SDK16, Deployment76, Identity7, Admin10 and UI16
through their exact public archives. Its existing genuine installed programme must rebuild
and measure the complete image/package/browser asset closure before exercising real
Postgres, Keycloak, Caddy, login/refresh/logout and durable host generation read-back.
No Identity/session/grant or endpoint authority moves into the UI library.

The trusted approved-committers policy remains the exact #620 blob
`b1a687db754ee2fac141919e6c63052d12bf2812`. All issues stay open. This alignment alone
is not assembled acceptance; the genuine installed programme and final Platform gates
must pass with these bytes.

### Public assembled fixture boundary

The `./testing` export provides `InstalledApiFixture` as an explicitly test-only producer.
An independent consumer supplies absolute paths for exact API/SDK/Deployment/Identity/Admin/UI
archives and a Bun v2 lock. The producer builds and measures the real API image and genuine
Postgres/Keycloak/Caddy release using public interfaces; it does not import sibling source.
Its default owner-test mode packs this owner's current built candidate. `close()` removes
only that fixture's resources and private files. Consumers separately own their browser/CLI
observations and never use this producer as installation authority.

Qualification failures retain both their original error and any subsequent host-drain error.
A cleanup failure must not hide the stage that failed or be interpreted as runtime acceptance.

The genuine installed API gate must use `ComposeDeploymentHost.apply` and the actual compiled
independent worker supplied by the prepared release. An in-process Node test host is not the
installed construction path. Fixture cleanup verifies the worker's executable device/inode
and owner before signaling it, then verifies retained containers remain running.

The compiled default-worker correction is selected as Deployment75, source `f5b511999a9196759f22d827ee4ee8fb7b48c8ba`, archive `fea365585ceaa9b813ba18c01fa78de2eca6335351fef86eeb9dcb37afbe4109`. Genuine installed verification is rerun against these exact bytes; no older failed configuration is counted as passing.

Final assembly now combines the separately qualified compiler and migration prefixes as
Deployment76. The frozen Deployment76 source is
`5ea1b2e76abd2b5531a765049f3afbef47abe8d4`, archive SHA-256
`021a67e0fb488114a12654667f72ebfefa5cbe95fc187a108c9694f1935ffbdf`.
Earlier qualification paragraphs retain historical checkpoints; package.json cordisCandidate
and Platform composition/task3c.json select current exact inputs. No frozen prior archive is overwritten.


Public container metadata declarations reference the SDK's existing container schema return type
explicitly. They must not inline an inferred schema whose union ordering can change with compiler
traversal/project paths. This preserves the same executable contract while stabilizing the
distributable declaration and exact archive identity. API6 completes this correction for both generic and retained historical container metadata; API4/API5 remain
a retained frozen historical candidate. Native provider behavior and Keycloak authority are unchanged.

The retained NodeApiContainerPlugin.definition/declaration and generic native declarations
also name their public SDK contracts explicitly. Historical four-role metadata remains only
in that compatibility export; the generic service host remains extensible. Hosted artifact
member diagnostics isolated the remaining variation to container.d.ts, with runtime files unchanged.
