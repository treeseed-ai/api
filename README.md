# `@treeseed/api`

TreeSeed remote SDK API platform package.

`@treeseed/api` is the HTTP analogue of `@treeseed/cli`: it is a thin runtime wrapper around SDK-owned behavior, with API-specific auth, request handling, and deployment concerns layered on top. The package exposes both the public Treeseed API app and the private Cloudflare agent gateway app.

## What It Provides

- `createTreeseedApiApp()` to create a portable Hono application
- `createRailwayTreeseedApiServer()` to run that app on Node with Railway-friendly defaults
- `createTreeseedGatewayApp()` to create the authenticated Cloudflare gateway Worker app
- `/sdk/:operation` routes that delegate to `@treeseed/sdk`
- `/cli/:command` routes that delegate to the shared Treeseed CLI runtime
- private task/workday/report endpoints for the control plane
- template catalog endpoints aligned with the existing remote template contract
- a built-in, low-footprint device-code auth provider with bearer-token validation
- provider registries and agent-ready seams for later co-located agent orchestration

## Requirements

- Node `>=20`
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

The gateway Worker is the narrow authenticated write surface between Railway or local Node services and Cloudflare:

- `POST /workdays/start`
- `POST /workdays/:id/close`
- `POST /tasks`
- `POST /tasks/:id/claim`
- `POST /tasks/:id/progress`
- `POST /tasks/:id/complete`
- `POST /tasks/:id/fail`
- `POST /tasks/:id/requeue`
- `POST /queue/enqueue`
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

When changing the private control plane:

- validate `createTreeseedGatewayApp()`
- validate the public API app still passes tests
- keep the public API and gateway app logically separate even if they share this package

When running on Railway, `RAILWAY_PUBLIC_DOMAIN` is used automatically to derive the public base URL when `TREESEED_API_BASE_URL` is not set.

## Notes

- The built-in auth provider uses in-memory device and refresh state to keep operational cost low in the first phase.
- SDK and CLI behavior remains owned by `@treeseed/sdk`; this package adapts that behavior to HTTP.
- The public API app and the private gateway app are intentionally different surfaces with different security expectations.
