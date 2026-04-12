# `@treeseed/api`

TreeSeed HTTP adapter package for the current SDK and agent runtimes.

`@treeseed/api` is a thin HTTP layer over `@treeseed/sdk` and `@treeseed/agent`. It owns auth, request handling, and deployment wiring, but keeps SDK and agent behavior in those packages rather than re-implementing orchestration logic locally.

## What It Provides

- `createTreeseedApiApp()` to create a portable Hono application
- `createRailwayTreeseedApiServer()` to run that app on Node with Railway-friendly defaults
- `createTreeseedGatewayApp()` to expose the same agent control-plane routes behind a gateway-style bearer-token boundary
- `/sdk/:operation` routes that mirror current SDK method names and remote contracts
- `/agent/...` routes for agent workday, task, context, graph, and report flows
- `/operations/:operation` routes for remote workflow execution
- template catalog endpoints aligned with SDK-owned template metadata
- a built-in, low-footprint device-code auth provider with bearer-token validation

## Requirements

- Node `>=22`
- npm as the canonical package manager

## Install

```bash
npm install @treeseed/api
```

## Local Use

Start the packaged server:

```bash
npm run build
npm start
```

Programmatic use:

```ts
import { createTreeseedApiApp } from '@treeseed/api';

const app = createTreeseedApiApp();
```

Gateway use:

```ts
import { AgentSdk } from '@treeseed/sdk';
import { createTreeseedGatewayApp } from '@treeseed/api/gateway';

const sdk = AgentSdk.createLocal({
	repoRoot: '/absolute/path/to/site',
	databaseName: 'treeseed-local',
});

const app = createTreeseedGatewayApp({
	sdk,
	bearerToken: process.env.TREESEED_GATEWAY_BEARER_TOKEN!,
});
```

## Environment

Common environment variables:

- `PORT`
- `HOST`
- `TREESEED_API_BASE_URL`
- `TREESEED_API_ISSUER`
- `TREESEED_API_AUTH_SECRET`
- `TREESEED_API_TEMPLATE_CATALOG_PATH`
- `TREESEED_API_PROVIDER_AUTH`
- `TREESEED_API_PROVIDER_AGENT_EXECUTION`
- `TREESEED_API_PROVIDER_AGENT_QUEUE`
- `TREESEED_API_PROVIDER_AGENT_NOTIFICATION`
- `TREESEED_API_PROVIDER_AGENT_REPOSITORY`
- `TREESEED_API_PROVIDER_AGENT_VERIFICATION`

Gateway-specific variables used by the wider system:

- `TREESEED_GATEWAY_BEARER_TOKEN`
- `TREESEED_PROJECT_ID`
- Cloudflare D1 binding for the operational database
- optional Cloudflare Queue producer binding for enqueue operations

## Gateway Responsibilities

The gateway app reuses the shared agent route handlers under a bearer-token boundary:

- `POST /workdays/start`
- `POST /workdays/:id/close`
- `POST /tasks`
- `POST /tasks/:id/claim`
- `POST /tasks/:id/progress`
- `POST /tasks/:id/complete`
- `POST /tasks/:id/fail`
- `POST /tasks/:id/requeue`
- `POST /tasks/:id/followups`
- `POST /queue/enqueue`
- `POST /context/resolve-task`
- `POST /graph/search`
- `POST /graph/subgraph`
- `POST /graph/query`
- `POST /graph/context-pack`
- `POST /graph/parse-dsl`
- `GET /graph/node/:id`
- `GET /specs`
- `POST /reports`
- `GET /healthz`

Operational rules:

- Railway and laptop processes talk to the gateway, not directly to D1
- the gateway owns authenticated task/workday/report state transitions
- producer-side queue writes should happen through the gateway
- worker-side queue pull tokens should stay out of the gateway

## Recommended Workflow

For package development:

```bash
npm install
npm run build
npm test
```

When changing the agent control plane:

- validate `createTreeseedGatewayApp()`
- validate the `/agent/...` namespace on the main API app
- keep SDK, agent, and workflow route modules separate even when they share helpers

When running on Railway, `RAILWAY_PUBLIC_DOMAIN` is used automatically to derive the public base URL when `TREESEED_API_BASE_URL` is not set.

## Notes

- The built-in auth provider uses in-memory device and refresh state to keep operational cost low in the first phase.
- SDK behavior remains owned by `@treeseed/sdk`; agent orchestration behavior remains owned by `@treeseed/agent`.
- The main API app exposes distinct `sdk`, `agent`, and `operations` surfaces; the gateway app reuses the agent handlers with a narrower trust boundary.
