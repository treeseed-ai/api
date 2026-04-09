import { resolve } from 'node:path';
import type { ApiConfig } from './types.ts';

function parseInteger(value: string | undefined, fallback: number) {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeUrl(value: string) {
	return value.endsWith('/') ? value.slice(0, -1) : value;
}

function resolveBaseUrl(env: NodeJS.ProcessEnv, host: string, port: number) {
	if (env.TREESEED_API_BASE_URL?.trim()) {
		return normalizeUrl(env.TREESEED_API_BASE_URL.trim());
	}

	if (env.RAILWAY_PUBLIC_DOMAIN?.trim()) {
		return normalizeUrl(`https://${env.RAILWAY_PUBLIC_DOMAIN.trim()}`);
	}

	return normalizeUrl(`http://${host}:${port}`);
}

export function resolveApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
	const host = env.HOST?.trim() || '0.0.0.0';
	const port = parseInteger(env.PORT, 3000);
	const baseUrl = resolveBaseUrl(env, host === '0.0.0.0' ? '127.0.0.1' : host, port);
	const issuer = normalizeUrl(env.TREESEED_API_ISSUER?.trim() || baseUrl);
	const repoRoot = resolve(env.TREESEED_API_REPO_ROOT?.trim() || process.cwd());

	return {
		name: env.TREESEED_API_NAME?.trim() || '@treeseed/api',
		host,
		port,
		baseUrl,
		issuer,
		repoRoot,
		authSecret: env.TREESEED_API_AUTH_SECRET?.trim() || 'treeseed-api-dev-secret',
		accessTokenTtlSeconds: parseInteger(env.TREESEED_API_ACCESS_TOKEN_TTL, 900),
		refreshTokenTtlSeconds: parseInteger(env.TREESEED_API_REFRESH_TOKEN_TTL, 7 * 24 * 60 * 60),
		deviceCodeTtlSeconds: parseInteger(env.TREESEED_API_DEVICE_CODE_TTL, 10 * 60),
		deviceCodePollIntervalSeconds: parseInteger(env.TREESEED_API_DEVICE_CODE_POLL_INTERVAL, 5),
		templateCatalogPath: env.TREESEED_API_TEMPLATE_CATALOG_PATH?.trim() || undefined,
		providers: {
			auth: env.TREESEED_API_PROVIDER_AUTH?.trim() || 'memory',
			agents: {
				execution: env.TREESEED_API_PROVIDER_AGENT_EXECUTION?.trim() || 'stub',
				queue: env.TREESEED_API_PROVIDER_AGENT_QUEUE?.trim() || 'memory',
				notification: env.TREESEED_API_PROVIDER_AGENT_NOTIFICATION?.trim() || 'stub',
				repository: env.TREESEED_API_PROVIDER_AGENT_REPOSITORY?.trim() || 'stub',
				verification: env.TREESEED_API_PROVIDER_AGENT_VERIFICATION?.trim() || 'stub',
			},
		},
	};
}
