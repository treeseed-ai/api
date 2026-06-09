# `@treeseed/api`

`@treeseed/api` is the deploy-only Treeseed backend package.

It owns the HTTP API, Treeseed PostgreSQL adapter, backend auth helpers, migrations, backend seed application, platform operation lifecycle, route descriptors, and Treeseed operations runner. The root web app should talk to this package only through HTTP/proxy/client surfaces.

The canonical repository is:

```text
git@github.com:treeseed-ai/api.git
```

## Runtime Ownership

This package owns:

- `src/api/**`: Hono API application and Node server entrypoint
- `src/operations-runner/**`: Treeseed operation claiming, checkpointing, execution, health, and runner entrypoint
- `src/api/market-postgres.*`: Treeseed PostgreSQL adapter
- backend auth and credential-session helpers
- API migrations and backend seed application
- API acceptance route descriptors and package-local API tests

The root Market repo owns:

- Astro web UI
- knowledge hub content
- auth, management, and Market UI pages
- `/v1/*` proxy route and UI API client only

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

## Binaries

```text
treeseed-api
treeseed-api-operations-runner
treeseed-api-db-migrate
```

## Package Scripts

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
npm run start:api
npm run start:runner
npm run db:migrate
```

Acceptance against a hosted API:

```bash
TREESEED_API_BASE_URL=<api-base-url> \
TREESEED_ACCEPTANCE_SERVICE_ID=<service-id> \
TREESEED_ACCEPTANCE_SERVICE_SECRET=<service-secret> \
npm run test:acceptance -- --base-url "$TREESEED_API_BASE_URL"
```

`verify:local` builds `dist`, checks package dependency boundaries, runs unit tests, validates generated output, and smoke-imports the public `dist` entrypoints. Hosted acceptance is run only when the API base URL and acceptance service credentials are configured; the package deploy workflow supplies those values for staging/prod, and the same suite can be run manually with `npm run test:acceptance -- --base-url <api-base-url>`.

## Deployment

Railway builds both backend services from this package root.

This package owns the API app desired state in `treeseed.site.yaml`: API service, indexed operations runner, PostgreSQL, API domains, variables, volumes, and public TreeDX federation hosting. Reconciliation must flow through `trsd hosting plan|apply|verify|destroy --app api` and the SDK canonical reconciliation platform; provider-side manual repairs are diagnostics only and should become adapter fixes.

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

The Treeseed PostgreSQL service must target both `api` and `operationsRunner` with `TREESEED_DATABASE_URL`.

Use this package's `TreeSeed API Deploy` GitHub workflow for hosted staging and production deployment. The root Market workflow does not deploy or accept the API. The package workflow verifies the package, reconciles the API app through `trsd hosting apply --app api`, verifies live Railway/API/runner/PostgreSQL/TreeDX state, runs the operations-runner smoke check, and then runs the hosted API acceptance suite before the workflow is green.

Use `trsd` directly for local/operator planning and live repair:

```bash
npx trsd ready staging --json
npx trsd hosting plan --environment staging --app api --json
npx trsd hosting apply --environment staging --app api --execute --json
npx trsd hosting verify --environment staging --app api --live --json
npx trsd operations smoke --environment staging --service operationsRunner --json
```

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

## Release

`@treeseed/api` is private and deploy-only for now. It still keeps standard Treeseed package scripts so package verification, tags, and workflow orchestration stay consistent with the other package repos.

```bash
npm run release:verify
npm run release:publish
```

`release:publish` should no-op or refuse clearly while the package remains private.

## Boundary Rules

- Do not use `workspace:` or `file:` dependency specs in this package repository.
- Do not import sibling package source paths. Use canonical public SDK exports.
- Do not move web UI code into this package.
- Do not make the root Market app import backend implementation from this package.
- Do not print secrets in logs, JSON reports, or acceptance output.
