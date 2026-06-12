# Changelog

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
