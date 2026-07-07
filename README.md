# @treeseed/api

`@treeseed/api` runs the Treeseed backend control plane: HTTP API, PostgreSQL-backed state, backend auth, operation lifecycle, migrations, seed application, route descriptors, operations runner, durable capacity coordination records, assignment APIs, ecommerce backend workflows, TreeSeed Commons governance APIs, and public TreeDX federation hosting.

Use this package when you operate or develop the Treeseed backend. Ordinary admin users interact with it through the web/admin UI or CLI, not by importing this package.

## Who Needs This Package

- operators deploying Treeseed API and operations-runner services
- maintainers changing backend routes, storage, auth, migrations, or operation execution
- acceptance-test runners validating hosted API behavior
- platform engineers wiring TreeDX federation into the Treeseed backend
- platform engineers implementing provider sessions, assignment leases, mode-run persistence, and capacity ledger settlement
- maintainers working on ecommerce registry, Stripe Connect/sync, checkout/order/entitlement, refunds, fulfillment, cooperative ownership, scoped services, capacity listing, seller monitoring, marketplace aggregation, or Commons governance APIs

The root market/admin web app reaches this package through HTTP/proxy/client surfaces only.

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
npm run test:unit
npm run verify:local
```

Runtime scripts:

```bash
npm run dev:api
npm run dev:runner -- --market local --watch --operation project:web_deployment --mock-external
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

Hosted acceptance:

```bash
TREESEED_API_BASE_URL=<api-base-url> \
TREESEED_ACCEPTANCE_SERVICE_ID=<service-id> \
TREESEED_ACCEPTANCE_SERVICE_SECRET=<service-secret> \
npm run test:acceptance -- --base-url "$TREESEED_API_BASE_URL"
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

The package deploy workflow verifies the package, reconciles the API app, verifies live Railway/API/runner/PostgreSQL/TreeDX state, runs operations-runner smoke checks, and runs hosted API acceptance before going green.

## Required Environment

API and runner:

- `TREESEED_DATABASE_URL`
- `TREESEED_PLATFORM_RUNNER_SECRET`
- `TREESEED_CREDENTIAL_SESSION_SECRET`
- API auth/service trust secrets configured by the environment

Runner:

- `TREESEED_PLATFORM_RUNNER_ID`
- `TREESEED_PLATFORM_RUNNER_DATA_DIR`
- `TREESEED_PLATFORM_RUNNER_ENVIRONMENT`
- `TREESEED_MANAGER_ID`

Web/API trust:

- `TREESEED_WEB_SERVICE_ID`
- `TREESEED_WEB_SERVICE_SECRET`
- `TREESEED_WEB_ASSERTION_SECRET`
- `TREESEED_API_BASE_URL`

Provider credentials are required only for enabled operation types. Manage them through Treeseed config and provider secret stores, not plaintext env files.

## Capacity Coordination Boundary

API owns durable provider availability sessions, assignment leases, reservations, mode-run records, usage actuals, and ledger settlement. The assignment function is request-scoped and runs during provider check-in, next-assignment requests, or explicit operator actions.

`@treeseed/agent` owns provider-local runtime behavior and AgentKernel execution. `@treeseed/sdk` owns portable contracts. Admin and CLI consume API contracts for operator visibility.

Provider runners should receive project-scoped TreeDX proxy handles rather than raw TreeDX credentials. API owns authentication, project scope checks, TreeDX node resolution, credential holding, and forwarding allowed `/v1/dx/projects/:projectId/...` operations.

## Ecommerce Boundary

Ecommerce Stripe behavior uses API-owned server credentials:

- `TREESEED_STRIPE_SECRET_KEY`
- `TREESEED_STRIPE_WEBHOOK_SECRET`
- `TREESEED_STRIPE_MODE`
- `TREESEED_STRIPE_CONNECT_ACCOUNT_TYPE`

`TREESEED_STRIPE_PUBLISHABLE_KEY` is non-secret and may be returned by the API to root-market buyer checkout pages. Admin must not use it to initialize Stripe Elements. Vendors never provide raw Stripe secret keys; TreeSeed creates and manages connected-account onboarding links through API routes.

## Public Exports

```text
@treeseed/api
@treeseed/api/api/app
@treeseed/api/api/server
@treeseed/api/api/store
@treeseed/api/api/market-postgres
@treeseed/api/operations-runner
@treeseed/api/route-descriptors
```

Published binaries:

```text
treeseed-api
treeseed-api-operations-runner
treeseed-api-db-migrate
```

## How API Fits With Other Packages

- `@treeseed/admin` renders admin UI and talks to API through HTTP/proxy/client facades.
- `@treeseed/ui` owns reusable visual components used by admin/market.
- root `@treeseed/market` hosts the web tenant, authenticated operational marketplace, checkout, service, capacity, Commons participant pages, and public marketing/profile/knowledge pages.
- `@treeseed/sdk` owns shared contracts, reconciliation, config, and workflow primitives used by API.
- `@treeseed/cli` exposes operator commands that call SDK/API surfaces.
- `@treeseed/agent` owns capacity-provider runtime, provider manager/runner behavior, and AgentKernel execution; API owns backend control-plane routes, provider sessions, assignment leases, mode-run records, and usage settlement for that runtime.
- `packages/treedx` owns the generic repository service image consumed by API hosting.

## What API Does Not Own

- web/admin routes or Astro pages
- reusable UI primitives
- root market content, public messaging, authenticated operational buyer Astro pages, public marketing/profile/knowledge pages, or reusable UI components
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
