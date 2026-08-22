import { resolve } from 'node:path';

const LOCAL_AUTH_TTL_SECONDS = 365 * 24 * 60 * 60;
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

function integer(value: string | undefined, fallback: number) {
	const parsed = Number.parseInt(value ?? '', 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function first(env: NodeJS.ProcessEnv, ...keys: string[]) {
	for (const key of keys) {
		const value = env[key]?.trim();
		if (value) return value;
	}
	return undefined;
}

function trimUrl(value: string) {
	return value.replace(/\/+$/u, '');
}

function loopback(value: string) {
	try { return ['127.0.0.1', 'localhost', '0.0.0.0'].includes(new URL(value).hostname); } catch { return false; }
}

function csv(value: string | undefined) {
	return [...new Set((value ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
}

export function resolveLocalApiDatabaseUrl(env: NodeJS.ProcessEnv = process.env) {
	const port = first(env, 'TREESEED_API_LOCAL_POSTGRES_PORT') ?? '54329';
	const database = first(env, 'TREESEED_API_LOCAL_POSTGRES_DATABASE') ?? 'treeseed_api';
	const user = first(env, 'TREESEED_API_LOCAL_POSTGRES_USER') ?? 'treeseed';
	const password = first(env, 'TREESEED_API_LOCAL_POSTGRES_PASSWORD') ?? 'treeseed-local-dev';
	return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(database)}`;
}

export function resolveApiDatabaseUrl(env: NodeJS.ProcessEnv = process.env, baseUrl?: string) {
	const explicit = first(env, 'TREESEED_DATABASE_URL');
	if (explicit) return explicit;
	const environment = first(env, 'TREESEED_API_ENVIRONMENT', 'TREESEED_ENVIRONMENT');
	return env.LOCAL_DEV_MODE !== undefined || environment === 'local' || (baseUrl ? loopback(baseUrl) : false)
		? resolveLocalApiDatabaseUrl(env)
		: undefined;
}

export function resolveApiConfig(env: NodeJS.ProcessEnv = process.env) {
	const host = env.HOST?.trim() || '0.0.0.0';
	const port = integer(env.PORT, 3000);
	const publicHost = host === '0.0.0.0' ? '127.0.0.1' : host;
	const baseUrl = trimUrl(env.TREESEED_API_BASE_URL?.trim() || (env.RAILWAY_PUBLIC_DOMAIN?.trim() ? `https://${env.RAILWAY_PUBLIC_DOMAIN.trim()}` : `http://${publicHost}:${port}`));
	const local = loopback(baseUrl);
	const approval = trimUrl(first(env, 'TREESEED_API_AUTH_APPROVAL_BASE_URL', 'TREESEED_SITE_URL', 'TREESEED_BETTER_AUTH_URL') ?? (local && new URL(baseUrl).port === '3000' ? `${new URL(baseUrl).protocol}//${new URL(baseUrl).hostname}:4321` : baseUrl));
	if (!local && loopback(approval)) throw new Error(`Refusing loopback device approval URL "${approval}" for remote API "${baseUrl}".`);
	return {
		name: env.TREESEED_API_NAME?.trim() || '@treeseed/api', host, port, baseUrl, authApprovalBaseUrl: approval,
		issuer: trimUrl(env.TREESEED_API_ISSUER?.trim() || baseUrl), repoRoot: resolve(env.TREESEED_API_REPO_ROOT?.trim() || process.cwd()),
		projectId: env.TREESEED_PROJECT_ID?.trim() || 'treeseed-api', authSecret: env.TREESEED_API_AUTH_SECRET?.trim() || 'treeseed-api-dev-secret',
		projectApiKey: env.TREESEED_API_PROJECT_KEY?.trim() || undefined, projectApiLabel: env.TREESEED_API_PROJECT_LABEL?.trim() || 'Project API Key',
		projectApiPermissions: csv(env.TREESEED_API_PROJECT_KEY_PERMISSIONS).length > 0 ? csv(env.TREESEED_API_PROJECT_KEY_PERMISSIONS) : ['sdk:execute:global', 'agent:execute:global', 'operations:execute:global'],
		cloudflareAccountId: env.TREESEED_CLOUDFLARE_ACCOUNT_ID?.trim() || undefined, cloudflareApiToken: env.TREESEED_CLOUDFLARE_API_TOKEN?.trim() || undefined,
		apiDatabaseUrl: resolveApiDatabaseUrl(env, baseUrl), webServiceId: first(env, 'TREESEED_WEB_SERVICE_ID', 'TREESEED_API_WEB_SERVICE_ID') || 'web',
		webServiceSecret: first(env, 'TREESEED_WEB_SERVICE_SECRET', 'TREESEED_API_WEB_SERVICE_SECRET') || 'treeseed-web-service-dev-secret',
		webAssertionSecret: first(env, 'TREESEED_API_WEB_ASSERTION_SECRET', 'TREESEED_WEB_ASSERTION_SECRET', 'TREESEED_API_AUTH_SECRET') || 'treeseed-web-assertion-dev-secret',
		webExchangeTtlSeconds: integer(env.TREESEED_API_WEB_EXCHANGE_TTL, 300), bootstrapAdminAllowlist: csv(env.TREESEED_API_BOOTSTRAP_ADMIN_ALLOWLIST),
		accessTokenTtlSeconds: integer(env.TREESEED_API_ACCESS_TOKEN_TTL, local ? LOCAL_AUTH_TTL_SECONDS : ACCESS_TOKEN_TTL_SECONDS),
		refreshTokenTtlSeconds: integer(env.TREESEED_API_REFRESH_TOKEN_TTL, local ? LOCAL_AUTH_TTL_SECONDS : REFRESH_TOKEN_TTL_SECONDS),
		deviceCodeTtlSeconds: integer(env.TREESEED_API_DEVICE_CODE_TTL, 600), deviceCodePollIntervalSeconds: integer(env.TREESEED_API_DEVICE_CODE_POLL_INTERVAL, 5),
		templateCatalogPath: env.TREESEED_API_TEMPLATE_CATALOG_PATH?.trim() || undefined,
		providers: { auth: 'control-plane-postgres', agents: { execution: env.TREESEED_API_PROVIDER_AGENT_EXECUTION?.trim() || 'codex', queue: env.TREESEED_API_PROVIDER_AGENT_QUEUE?.trim() || 'memory', notification: env.TREESEED_API_PROVIDER_AGENT_NOTIFICATION?.trim() || 'sdk_message', repository: env.TREESEED_API_PROVIDER_AGENT_REPOSITORY?.trim() || 'git', verification: env.TREESEED_API_PROVIDER_AGENT_VERIFICATION?.trim() || 'local' } },
	};
}
