# @treeseed/api

The governance inbox API aggregates TreeDX-backed questions, versioned proposals, and their Discussion threads for an active team. PostgreSQL stores the query projection, routing timeline, action receipts, and private per-user drafts while authored content retains exact TreeDX provenance.

`@treeseed/api` runs the TreeSeed control plane: typed REST operations, deterministic OpenAPI, the remote MCP endpoint, PostgreSQL-backed state, authentication, governance, operation lifecycle, seed application, capacity coordination, assignments, and TreeDX federation hosting.

The package owns its control-plane database baseline and seed validation/application, not tenant topology. Set `TREESEED_SEED_ROOT` to the deployment-owned directory containing `seeds/*.yaml`. External product integrations are not bundled into this repository.

Use this package when you operate or develop the Treeseed backend. Ordinary admin users interact with it through the web/admin UI or CLI, not by importing this package.

## Who Needs This Package

- operators deploying Treeseed API and operations-runner services
- maintainers changing backend routes, storage, auth, migrations, or operation execution
- platform engineers wiring TreeDX federation into the Treeseed backend
- platform engineers implementing provider sessions, assignment leases, mode-run persistence, and capacity ledger settlement
- maintainers working on accounts, projects, governance, knowledge, capacity, workdays, assignments, OpenAPI, OAuth, or MCP

Site and external clients reach this package through its REST or MCP surfaces.

## Authentication and account ownership

The API is authoritative for normalized username/email availability, registration races, immutable usernames, configured OAuth providers, one-time state/nonce/PKCE, explicit identity linking, scoped five-minute reauthentication, email/credential/session lifecycle, deletion blockers, personal themes, and exact notification preferences. The operations runner also owns idempotent immediate/daily/weekly notification delivery. Admin never persists or reimplements these policies.

Cookie-authenticated browser mutations cross the Admin same-origin proxy, which enforces the shared double-submit CSRF contract before converting the cookie session to a bearer request. Direct bearer clients remain independent of browser CSRF.

## Runtime Services

Railway builds backend services from this package root:

```text
api
  rootDir: packages/api
  buildCommand: npm run build
  startCommand: npm run start:api
  healthcheckPath: /healthz
  runtimeMode: serverless

operationsRunner
  rootDir: packages/api
  buildCommand: npm run build
  startCommand: npm run start:runner
  healthcheckPath: /healthz
  runtimeMode: service
  volumeMountPath: /data
```

Treeseed PostgreSQL targets both services with `TREESEED_DATABASE_URL`. Local development derives the value from the managed local API Postgres settings; hosted environments receive the reconciled PostgreSQL URL as a service secret.

## Install And Verify

```bash
npm install
npm run build
npm test
npm run verify
```

Runtime scripts:

```bash
npm run dev:api
npm run dev:runner -- --server local --watch --operation project:web_deployment
npm run dev:compose
npm run start:api
npm run start:runner
npm run db:migrate
```

Local Docker Compose runs the API, operations runner, and PostgreSQL with the same Railway-owned service shape used by hosting reconciliation. The Compose file does not use `env_file` or plaintext `.env` secrets; run it from a `trsd`-unlocked environment so required variables are injected into the process environment.

```bash
npm run dev:compose
npm run dev:compose:logs
npm run dev:compose:down
```

## Deployment

Reconciliation must flow through `trsd`; direct provider mutation is diagnostic only.

```bash
npx trsd operations smoke --environment local --service operationsRunner --json
npx trsd ready staging --json
npx trsd hosting plan --environment staging --app api --json
npx trsd hosting apply --environment staging --app api --json
npx trsd hosting verify --environment staging --app api --live --json
npx trsd operations smoke --environment staging --service operationsRunner --json
```

The package verification workflow builds the package, runs the focused control-plane protocol suite, checks the supported executables, and packs the exact artifact. Hosted deployment remains fail-closed during this cutover.

## Required Environment

API and runner:

- `TREESEED_DATABASE_URL`
- `TREESEED_PLATFORM_RUNNER_SECRET`
- API auth/service trust secrets configured by the environment

Runner:

- `TREESEED_PLATFORM_RUNNER_ID`
- `TREESEED_PLATFORM_RUNNER_DATA_DIR`
- `TREESEED_PLATFORM_RUNNER_ENVIRONMENT`
- `TREESEED_SERVER_ID`

Web/API trust:

- `TREESEED_WEB_SERVICE_ID`
- `TREESEED_WEB_SERVICE_SECRET`
- `TREESEED_WEB_ASSERTION_SECRET`
- `TREESEED_API_BASE_URL`

Provider credentials are required only for enabled operation types. Manage them through Treeseed config and provider secret stores, not plaintext env files.

## Capacity Coordination Boundary

API owns durable provider availability sessions, assignment leases, reservations, mode-run records, usage actuals, and ledger settlement. The assignment function is request-scoped and runs during provider check-in, next-assignment requests, or explicit operator actions.

`@treeseed/agent` owns provider-local runtime behavior and AgentKernel execution. `@treeseed/sdk` owns portable contracts. Admin and CLI consume API contracts for operator visibility.

Team discussion topics are cross-project coordination scopes. The API resolves qualified `@project/agent` addresses exactly and expands bare `@agent` handles across every active project, writes the message through each addressed project's TreeDX stream, and tracks the complete response and handoff chain under one PostgreSQL send identity.

Provider runners should receive project-scoped TreeDX proxy handles rather than raw TreeDX credentials. API owns authentication, project scope checks, TreeDX node resolution, credential holding, and forwarding allowed `/v1/dx/projects/:projectId/...` operations.

## Supported entrypoints

The API does not expose its store, route installers, application internals, or database adapters as an importable library. Its supported package entrypoints are these executables:

```text
treeseed-api
treeseed-api-operations-runner
treeseed-api-db-migrate
```

## How API Fits With Other Packages

- `@treeseed/admin` renders admin UI and talks to API through HTTP/proxy/client facades.
- `@treeseed/ui` owns reusable visual components.
- `@treeseed/sdk` owns shared contracts, reconciliation, config, and workflow primitives used by API.
- `@treeseed/cli` exposes operator commands that call SDK/API surfaces.
- `@treeseed/agent` owns capacity-provider runtime, provider manager/runner behavior, and AgentKernel execution; API owns backend control-plane routes, provider sessions, assignment leases, mode-run records, and usage settlement for that runtime.
- `packages/treedx` owns the generic repository service image consumed by API hosting.

## What API Does Not Own

- web/admin routes or Astro pages
- reusable UI primitives
- site content, public messaging, or reusable UI components
- CLI command UX
- capacity provider manager/runner/worker implementation or AgentKernel execution
- TreeDX internals

## Release

`@treeseed/api` is deploy-only/private for now. It keeps standard Treeseed package scripts so package verification, tags, and workflow orchestration stay consistent.

```bash
npm run release:verify
npm run release:publish
```

`release:publish` should no-op or refuse clearly while the package remains private.

See the root [Package Ownership](../../docs/package-ownership.md) guide for cross-package boundaries.
