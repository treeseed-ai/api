# Changelog

## [0.6.37] - 2026-07-06

### Fixed

- build(build): fix Railway Dockerfile hosted build command verification (78fa0a1d79f0)

### Tests

- test(tests): complete starter, api guarantee, and agent live (76a1db9c156b)
- build(deps): complete starter, api guarantee, and agent live (cb50b2e52fab)

## [0.6.36] - 2026-07-05

### Fixed

- ci(build): fix Docker Hub attestation verification (0c2e3932fca7)

### Infrastructure

- ci(ci): harden container image release security (32078179e79a)

### Dependencies

- build(build): add final production release guarantee gate (58ffbe2a833b)

## [0.6.34] - 2026-07-05

### Fixed

- build(build): fix production source cache purge finalization (8dc022ae4a98)

## [0.6.33] - 2026-07-05

### Dependencies

- build(build): bypass source page edge cache for production release (4bfabfb1aa8f)
- build(build): make live hosted env checks provider authoritative (d4c688305b5e)
- build(build): fail release on broken production web surface (be0d90c6f32e)

## [0.6.32] - 2026-07-04

### Dependencies

- build(build): purge production web cache before release verification (dcb80e3a25a2)
- build(build): purge production web cache before release verification (9ee7850ca114)

## [0.6.31] - 2026-07-04

### Changed

- Release metadata and deployment history updated.

## [0.6.30] - 2026-07-04

### Changed

- Release metadata and deployment history updated.

## [0.6.29] - 2026-07-04

### Changed

- Release metadata and deployment history updated.

## [0.6.28] - 2026-07-04

### Changed

- Release metadata and deployment history updated.

## [0.6.27] - 2026-07-04

### Fixed

- fix: target live api acceptance url (629672241e71)

## [0.6.26] - 2026-07-04

### Changed

- Release metadata and deployment history updated.

## [0.6.25] - 2026-07-04

### Changed

- Release metadata and deployment history updated.

## [0.6.24] - 2026-07-04

### Changed

- Release metadata and deployment history updated.

## [0.6.23] - 2026-07-04

### Fixed

- fix: run api hosting apply without execute flag (3da759d3a3b1)
- fix: run api hosting apply without execute flag (acc2f1e9500a)

## [0.6.22] - 2026-07-04

### Changed

- refactor: replace preview API paths with plan mode (129f539f88db)
- Require explicit production TreeDX image refs (343ae5997fdb)

## [0.6.21] - 2026-07-03

### Changed

- Release metadata and deployment history updated.

## [0.6.20] - 2026-07-03

### Infrastructure

- Pass release environment config to API deploy (834edf95b7b9)

## [0.6.19] - 2026-07-03

### Changed

- Release metadata and deployment history updated.

## [0.6.18] - 2026-07-03

### Fixed

- fix: retry npm install in release images (667ab4a832e1)

## [0.6.17] - 2026-07-03

### Fixed

- fix: use https git refs for hosted api builds (dffbbd3d0750)
- fix: retry hosted acceptance seed users (587c766457b3)
- fix: report hosted acceptance seed failures (0f16d0724e17)
- fix: bypass hosted sdk acceptance email delivery (0198fcf40dfc)
- fix: keep acceptance nonce within API limits (9dfb7dffdfc8)
- fix: scope hosted acceptance email bypass (5798abe30066)
- fix: stabilize hosted acceptance seeding (2816befd1c4c)
- fix: bypass hosted acceptance email delivery (a86b6b30a1b9)
- fix: propagate api live service credential to deploy (998ab9333428)
- fix: resolve live api smoke credentials from config (4626bd4f7582)
- fix: prefer api acceptance service credential (7d07e6fbcf64)
- chore: use latest cli live verifier fix (726c655a9aaf)
- chore: use latest cli staging reconciler fix (228f4089af6f)
- chore: use cli staging reconciler fix (5d6c1de60b87)
- chore: use sdk staging reconciler fix (efd9a2fd9bee)
- fix: wait for production images before API deploy (08e6ef7cc3d5)

### Infrastructure

- ci: load live API credentials for smoke verification (85227095aa9e)
- ci: align API live verifier service credential (4ee5868129df)

### Tests

- test: allow pinned staging cli dependency (889cbb09c5d2)

## [0.6.16] - 2026-07-03

### Changed

- Release metadata and deployment history updated.

## [0.6.15] - 2026-07-03

### Changed

- Release metadata and deployment history updated.

## [0.6.14] - 2026-07-03

### Changed

- Release metadata and deployment history updated.

## [0.6.13] - 2026-07-03

### Changed

- Release metadata and deployment history updated.

## [0.6.12] - 2026-07-03

### Changed

- Release metadata and deployment history updated.

## [0.6.11] - 2026-07-02

### Changed

- Release metadata and deployment history updated.

## [0.6.10] - 2026-07-02

### Changed

- Isolate local API acceptance credentials (7c4d2dff8540)

### Fixed

- Fix production CLI dependency release assertion (d68a2a41e610)

## [0.6.9] - 2026-07-02

### Changed

- Activate API acceptance guarantees (c62b0223063a)

### Fixed

- fix(release): advance staging sdk lock recovery ref (9ce14b5353cc)
- fix(release): advance staging sdk and cli refs (b5554fda47a9)
- fix(release): advance staging sdk verification ref (bc704569162b)
- fix(release): advance staging sdk reference (b5f9e01a3ceb)
- fix(release): restore staging dependency refs (1788db673fed)

## [0.6.8] - 2026-07-02

### Fixed

- fix(release): restore staging dependency refs (441bbb1dc362)

## [0.6.7] - 2026-07-02

### Fixed

- fix(release): refresh staging package refs (1492030fe7bd)
- fix(release): use staging package commit refs (a192933d0757)

## [0.6.6] - 2026-07-02

### Fixed

- fix(release): retry transient acceptance requests (e032f484aef5)

## [0.6.5] - 2026-07-02

### Fixed

- fix(release): declare dockerhub username variable (aec13b30db82)

## [0.6.4] - 2026-07-02

### Fixed

- fix(release): publish plain semver tags (cf3214b99bcf)

## [0.6.3] - 2026-07-02

### Changed

- Release metadata and deployment history updated.

## [0.6.2] - 2026-07-01

### Changed

- Release metadata and deployment history updated.

## [0.6.1] - 2026-07-01

### Changed

- Release metadata and deployment history updated.

## [0.6.0] - 2026-07-01

### Added

- feat(api): replay stale API Postgres baseline markers (e1ea5e7df366)
- feat(api): require full API Postgres baseline before adoption (b0d7eac9decc)
- feat(api): replay partial API Postgres baselines idempotently (eef047d3b98e)
- feat(api): make API Postgres baseline recovery idempotent (2a310b73ea42)
- feat(api): adopt existing API Postgres baseline migrations (d7de42bf3621)
- feat(api): switch hosted domains to treeseed.dev (b13575f19038)

### Fixed

- build(build): fix image release root directory verification (58509cdde5f5)
- build(build): fix Railway runtime config verification (afd3e5277388)
- build(build): fix release guarantee API verifiers (17d71701542a)
- build(build): fix staging release guarantee auth (16e15f6210f8)
- build(build): fix production release gates (81789c19adfb)
- ci(ci): promotion proof after CI and acceptance fixes (1f727c516533)
- ci(build): promotion proof after CI and acceptance fixes (0706bfec4d47)
- build(build): fix SDK proof regressions after guarantee framework (9596772a70be)
- build(build): fix guarantees CLI help metadata (bd9fd43b8d26)
- test(tests): fix API acceptance team member isolation after guarantee (3b2acabb0a0d)
- build(build): fix proof tests for clean hosted runners (4a77d550d15c)
- build(build): fix promotion release gate assertions (12ce0c1d8a4a)
- build(build): fix TreeDX release gate Beam setup (7cd8a0ee863f)
- ci(build): fix scoped project domains for staging Pages (80b3bcfe4121)
- build(build): fix Railway deploy live verification settle window (d3ae125b1451)
- build(build): fix Agent capacity provider Docker build shape test (8c0ab432638a)
- ci(build): fix staging hosted service credential and Railway source (76c7d65d64d0)
- build(build): fix Railway IaC-only reconciliation and TreeDX env names (7ee1e5a9df1f)
- ci(ci): fix Railway staging Dockerfile builds and persistent volumes (00ff508c2945)
- test(tests): fix staging Railway source builds and volumes (299c7d61dcbb)
- 19 additional changes omitted from this summary.

### Tests

- build(config): checkpoint user and team guarantees passing locally (fac369f71a4c)
- ci(build): pin hosted workflow API domains to treeseed.dev (dc677e85626c)
- test(tests): allow API release graph CLI tarball dependency (d44624968b5a)
- test(tests): use image-backed Railway API staging services (6a7b1b2792d1)
- build(tests): implement proposal governance decision pipeline (4bb8616e0fdb)
- ci(build): checkpoint before verify action and local dev stack (53b0e5cf5e7b)

### Dependencies

- build(build): allow first production API domain validation (9bbdaff3fc30)
- build(build): merge package main history back to staging (74c77399371d)
- build(build): replace legacy strict tail with proof ledger (032b9fac94fd)
- build(build): implement incremental release proof (a6a3af58b25b)
- build(build): use configured API domains for hosted reconciliation (b485778d3cc9)
- build(build): include domain units in promotion hosted reconciliation (5ae49e9f569e)
- build(build): harden Railway IaC reconciliation and domain verification (e4d0f898b68c)
- build(deps): repair managed worktree cleanup after docker verification (9672f7e1a730)
- build(build): finish staging workflow hardening checkpoint (bbe921aadae8)
- build(build): exclude build artifacts from stage proof workspace (8fac34dc4b85)
- build(build): update stage command help text (9d93c8763fc6)
- build(build): rework stage promotion workflow (779b206c9db3)
- ci(build): use image-backed Railway API staging services (5e22db2997e8)
- build(build): skip opaque railway sync provider errors after retries (95ccf1cc100f)
- build(build): tolerate railway deploy trigger processing errors (dc0c76a2055a)
- build(build): retry transient railway hosted sync failures (9902a0a600d9)
- build(build): tolerate railway existing service source update limits (7e32f7657287)
- build(build): repair railway existing service deployment recovery (6b6608698d0d)
- build(docs): implement model-aware agent content tools (47884fc3f32c)
- build(build): remove legacy Mailpit dev hooks (4e44be484ffb)
- 9 additional changes omitted from this summary.

## [0.5.0] - 2026-06-12

### Added

- feat(api): migrate Market backend package (43a3da0086e9)

### Changed

- Initial implementation of user management, auth, and rbac. (ec4b7a3c4613)
- Adding the treeseed fixtures repository. (e78292ef612c)
- Cleanup and architectural consolidation. (32f5752d500e)
- Cleanup and architectural consolidation. (bbbd83b6eeee)
- Updates to the graph query SDK. (dc439528017e)
- Updates related to package verification process. (8c1362dff5b8)
- Updating SDK and core versions and incrementing the minor version. (43f651a5473d)
- Readding more of the API processing logic that found its way into the SDK. (932d7d7e339c)
- Adding a application gateway service. (2260c6e80e6d)
- Initial commit. (689442581a96)

### Fixed

- fix: require injected Compose secrets (60ea3d36a4ed)
- fix: align API runtime and image publishing (271ad116864a)
- build(build): fix package deploy gate timeout and hybrid save validation (1d3e681d36cf)
- build(build): fix package deploy gate timeout and hybrid save validation (82d3fac6dc3c)
- build(build): fix railway live deploy readiness retry (740b8f99c909)
- build(build): fix workspace deployment install readiness (90666c1e59e4)
- build(build): fix ui pages staging reconciliation (7304e471031a)
- build(build): fix package app cloudflare auth (abac4ca19020)
- ci(build): fix package hosted config sync and api deploy environment (7f6b47c1b3c3)
- ci(build): fix api deploy workflow cli dependency (a29d201f40d6)
- build(build): fix hosted repository gates and root lockfile refresh (7400e0671466)
- fix(source): Save reconciliation platform and live acceptance updates (6dc3aac79de9)
- fix(api): clone SDK when vendoring deploy runtime (13fa91ccfbe0)
- fix(api): pack SDK runtime when vendoring deploy artifacts (ba3394d263dc)
- fix(api): vendor SDK runtime for standalone deploy (5d75e0cb7a80)
- fix(api): pin SDK deploy dependency to verified commit (11b3f7a5c460)
- fix(api): build installed SDK dependency for deploy (8a7ca2f70c13)
- fix(ci): declare React email renderer dependency (2dd490a8a3fa)
- build(build): complete Market API package migration hosted checker fix (d3b6310037f7)

### Infrastructure

- ci(api): add release publish workflow (9533b72c2a1f)

### Tests

- test: isolate API unit D1 state (d9cc87e5a4d0)
- test: keep API verify state out of wrangler cache (8aed707ecb2f)
- ci(build): finish staging save after dependency repair (9f0e0427e2fa)
- build(docs): Push clean hosted project repositories during save (68ba94c74e7a)
- test(tests): Push clean hosted project repositories during save (c71c64634188)
- test(tests): Push clean hosted project repositories during save (06ab9915f4b7)
- ci(build): Move API deployment acceptance into API package (228b90a4d9dd)
- build(source): Save reconciliation platform and live acceptance updates (189b5ab56506)
- test(api): mock provider launch for package CI (036bf7b19673)
- Fixing some test issues related to the refactor. (0ee229c697cd)

### Dependencies

- build(build): stage package submodule restructuring (a5f55afd8fe6)
- build(build): document save lanes (48b2aa347ee6)
- build(build): add fast and promotion save lanes (682e1f2f7433)
- build(deps): update @treeseed/sdk and @treeseed/cli (c3cf9ba4a341)
- build(build): bound git dependency smoke checks (fede18ccd1cb)
- build(build): build ui artifacts for hosted deploy (42a6292dafa9)
- build(build): migrate reusable ui components to treeseed ui (2d3a7b1f167a)
- build(build): integrate treeseed ui (c602e7bcd741)
- build(build): make cli json output robust under capture (31fc2be96ee0)
- build(build): stabilize agent verification under save load (7cb91aef1e5e)
- chore(deps): update @treeseed/sdk (debc9ef0a4e5)
- build(build): Push clean hosted project repositories during save (a95a680cfbda)
- build(build): Install project dependencies before hosted project (4758dc76ad50)
- build(build): Install project dependencies before hosted project (236cfc6ac749)
- build(build): Install project dependencies before hosted project (841864dd0155)
- build(build): Treat API as a hosted project with verification gates (3535b30021bb)
- build(build): Save reconciliation platform and live acceptance updates (e8c291b362af)
- build(build): Save reconciliation platform and live acceptance updates (2af28e37b84e)
- Updating dependency versions. (c7c646a02158)
- Updating dependency versions. (0e86d573f755)
- 2 additional changes omitted from this summary.
