# `@treeseed/api`

TreeSeed remote SDK API platform package.

`@treeseed/api` is the HTTP analogue of `@treeseed/cli`: it is a thin runtime wrapper around SDK-owned behavior, with API-specific auth, request handling, and deployment concerns layered on top. The package exposes a Hono application factory, a Railway-oriented Node bootstrap, and a device-code authentication flow intended for CLI consumers.

## What It Provides

- `createTreeseedApiApp()` to create a portable Hono application
- `createRailwayTreeseedApiServer()` to run that app on Node with Railway-friendly defaults
- `/sdk/:operation` routes that delegate to `@treeseed/sdk`
- `/cli/:command` routes that delegate to the shared Treeseed CLI runtime
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

When running on Railway, `RAILWAY_PUBLIC_DOMAIN` is used automatically to derive the public base URL when `TREESEED_API_BASE_URL` is not set.

## Notes

- The built-in auth provider uses in-memory device and refresh state to keep operational cost low in the first phase.
- `/agents` routes are reserved and return a placeholder response in this phase.
- SDK and CLI behavior remains owned by `@treeseed/sdk`; this package adapts that behavior to HTTP.
