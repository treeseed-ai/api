import type { APIContext } from 'astro';
import type { CloudflareRuntime } from '@treeseed/core/types/cloudflare';

export const WEB_SESSION_COOKIE = 'ts_session';
export const WEB_CSRF_COOKIE = 'ts_csrf';
const DEFAULT_WEB_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_EMAIL_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_LOCAL_SMTP_HOST = '127.0.0.1';
const DEFAULT_LOCAL_SMTP_PORT = 1025;
const DEFAULT_LOCAL_AUTH_EMAIL_FROM = 'Treeseed Market <auth@treeseed.local>';
export const BETTER_AUTH_BASE_PATH = '/v1/auth';
const AUTH_MODES = new Set(['internal-first', 'internal-only', 'providers-only']);
const INTERNAL_SIGNUP_MODES = new Set(['open', 'invite', 'admin']);
const LOCAL_AUTH_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

type RuntimeEnv = CloudflareRuntime['env'];

function runtimeEnv(context?: Pick<APIContext, 'locals'>) {
	return ((context?.locals as { runtime?: CloudflareRuntime } | undefined)?.runtime)?.env;
}

function envValue(name: string, env?: RuntimeEnv) {
	const runtime = env as Record<string, unknown> | undefined;
	const runtimeValue = runtime?.[name];
	if (typeof runtimeValue === 'string' && runtimeValue.trim()) {
		return runtimeValue.trim();
	}
	const processValue = process.env[name];
	return typeof processValue === 'string' && processValue.trim() ? processValue.trim() : '';
}

function firstEnvValue(env: RuntimeEnv | undefined, ...names: string[]) {
	for (const name of names) {
		const value = envValue(name, env);
		if (value) return value;
	}
	return '';
}

function parseIntEnv(name: string, fallback: number, env?: RuntimeEnv) {
	const value = envValue(name, env);
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBooleanEnv(name: string, fallback: boolean, env?: RuntimeEnv) {
	const value = envValue(name, env).toLowerCase();
	if (!value) return fallback;
	return ['1', 'true', 'yes', 'on'].includes(value)
		? true
		: ['0', 'false', 'no', 'off'].includes(value)
			? false
			: fallback;
}

function parseEnumEnv<T extends string>(name: string, allowed: Set<T>, fallback: T, env?: RuntimeEnv) {
	const value = envValue(name, env) as T;
	return allowed.has(value) ? value : fallback;
}

function normalizeUrl(value: string, fallback: string) {
	try {
		const url = new URL(value || fallback);
		url.search = '';
		url.hash = '';
		return url;
	} catch {
		return new URL(fallback);
	}
}

function isLocalUrl(value: string) {
	try {
		return LOCAL_AUTH_HOSTNAMES.has(new URL(value).hostname);
	} catch {
		return false;
	}
}

export function normalizeSiteBaseUrl(value: string, fallback = 'http://127.0.0.1:4321') {
	const url = normalizeUrl(value, fallback);
	const pathname = url.pathname.replace(/\/+$/u, '');
	url.pathname = pathname.endsWith(BETTER_AUTH_BASE_PATH)
		? pathname.slice(0, -BETTER_AUTH_BASE_PATH.length) || '/'
		: pathname || '/';
	return url.pathname === '/' ? url.origin : `${url.origin}${url.pathname}`;
}

export function normalizeBetterAuthBaseUrl(value: string, fallback = 'http://127.0.0.1:4321') {
	const url = normalizeUrl(value, fallback);
	const pathname = url.pathname.replace(/\/+$/u, '');
	url.pathname = pathname.endsWith(BETTER_AUTH_BASE_PATH) ? pathname : BETTER_AUTH_BASE_PATH;
	return `${url.origin}${url.pathname}`;
}

export function localAuthCanonicalRedirectUrl(requestUrl: URL, configuredSiteBaseUrl: string) {
	const canonical = normalizeUrl(configuredSiteBaseUrl, 'http://127.0.0.1:4321');
	if (!isLocalUrl(requestUrl.href) || !isLocalUrl(canonical.href)) return null;
	if (
		requestUrl.protocol === canonical.protocol
		&& requestUrl.hostname === canonical.hostname
		&& requestUrl.port === canonical.port
	) {
		return null;
	}
	const redirectUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, canonical.origin);
	return redirectUrl;
}

export function getSiteAuthConfig(context?: Pick<APIContext, 'locals'> & Partial<Pick<APIContext, 'url'>>) {
	const env = runtimeEnv(context);
	const authMode = parseEnumEnv('TREESEED_AUTH_MODE', AUTH_MODES, 'internal-first', env);
	const internalSignup = parseEnumEnv('TREESEED_AUTH_INTERNAL_SIGNUP', INTERNAL_SIGNUP_MODES, 'open', env);
	const requestOrigin = context?.url?.origin ?? '';
	const configuredSiteBaseUrl = envValue('TREESEED_SITE_URL', env) || envValue('TREESEED_BETTER_AUTH_URL', env) || requestOrigin || 'http://127.0.0.1:4321';
	const siteBaseUrl = normalizeSiteBaseUrl(configuredSiteBaseUrl);
	const betterAuthBaseUrl = normalizeBetterAuthBaseUrl(envValue('TREESEED_BETTER_AUTH_URL', env) || siteBaseUrl);
	const localAuthEmail = isLocalUrl(siteBaseUrl) || isLocalUrl(betterAuthBaseUrl);
	const localMailpitHost = envValue('TREESEED_MAILPIT_SMTP_HOST', env) || DEFAULT_LOCAL_SMTP_HOST;
	const localMailpitPort = parseIntEnv('TREESEED_MAILPIT_SMTP_PORT', DEFAULT_LOCAL_SMTP_PORT, env);
	const authEmailFrom = firstEnvValue(env, 'TREESEED_AUTH_EMAIL_FROM', 'TREESEED_SMTP_FROM')
		|| (localAuthEmail ? DEFAULT_LOCAL_AUTH_EMAIL_FROM : '');
	return {
		authMode,
		internalAuthEnabled: authMode !== 'providers-only',
		internalSignup,
		internalSignupEnabled: authMode !== 'providers-only' && internalSignup === 'open',
		providersEnabled: authMode !== 'internal-only',
		emailLinkingEnabled: parseBooleanEnv('TREESEED_AUTH_EMAIL_LINKING', true, env),
		allowMemoryAuthDb: parseBooleanEnv('TREESEED_AUTH_ALLOW_MEMORY_DB', false, env),
		betterAuthSecret: envValue('TREESEED_BETTER_AUTH_SECRET', env) || 'treeseed-local-better-auth-secret-minimum-32-characters',
		siteBaseUrl,
		betterAuthBaseUrl,
		apiServiceId: firstEnvValue(env, 'TREESEED_WEB_SERVICE_ID', 'TREESEED_API_WEB_SERVICE_ID') || 'web',
		apiServiceSecret: firstEnvValue(env, 'TREESEED_WEB_SERVICE_SECRET', 'TREESEED_API_WEB_SERVICE_SECRET') || 'treeseed-web-service-dev-secret',
		apiAssertionSecret: firstEnvValue(env, 'TREESEED_WEB_ASSERTION_SECRET', 'TREESEED_API_WEB_ASSERTION_SECRET') || 'treeseed-web-assertion-dev-secret',
		csrfSecret: envValue('TREESEED_WEB_CSRF_SECRET', env) || 'treeseed-web-csrf-dev-secret',
		sessionTtlSeconds: parseIntEnv('TREESEED_WEB_SESSION_TTL', DEFAULT_WEB_SESSION_TTL_SECONDS, env),
		passwordResetTtlSeconds: parseIntEnv('TREESEED_AUTH_PASSWORD_RESET_TTL', DEFAULT_EMAIL_TOKEN_TTL_SECONDS, env),
		emailVerificationTtlSeconds: parseIntEnv('TREESEED_AUTH_EMAIL_VERIFICATION_TTL', DEFAULT_EMAIL_TOKEN_TTL_SECONDS, env),
		emailVerificationEnabled: parseBooleanEnv('TREESEED_AUTH_EMAIL_VERIFICATION_ENABLED', true, env),
		authEmail: {
			host: localAuthEmail ? localMailpitHost : envValue('TREESEED_SMTP_HOST', env),
			port: localAuthEmail ? localMailpitPort : parseIntEnv('TREESEED_SMTP_PORT', 465, env),
			username: localAuthEmail ? '' : envValue('TREESEED_SMTP_USERNAME', env),
			password: localAuthEmail ? '' : envValue('TREESEED_SMTP_PASSWORD', env),
			from: authEmailFrom,
			replyTo: firstEnvValue(env, 'TREESEED_AUTH_EMAIL_REPLY_TO', 'TREESEED_SMTP_REPLY_TO'),
			secure: localAuthEmail ? '' : envValue('TREESEED_SMTP_SECURE', env),
		},
		providers: {
			github: {
				clientId: envValue('TREESEED_AUTH_GITHUB_CLIENT_ID', env),
				clientSecret: envValue('TREESEED_AUTH_GITHUB_CLIENT_SECRET', env),
			},
			google: {
				clientId: envValue('TREESEED_AUTH_GOOGLE_CLIENT_ID', env),
				clientSecret: envValue('TREESEED_AUTH_GOOGLE_CLIENT_SECRET', env),
			},
			microsoft: {
				clientId: envValue('TREESEED_AUTH_MICROSOFT_CLIENT_ID', env),
				clientSecret: envValue('TREESEED_AUTH_MICROSOFT_CLIENT_SECRET', env),
			},
			apple: {
				clientId: envValue('TREESEED_AUTH_APPLE_CLIENT_ID', env),
				clientSecret: envValue('TREESEED_AUTH_APPLE_CLIENT_SECRET', env),
			},
		},
	};
}

export function webCookieOptions(requestUrl: URL, maxAge: number) {
	return {
		httpOnly: true,
		path: '/',
		sameSite: 'lax' as const,
		secure: requestUrl.protocol === 'https:',
		maxAge,
	};
}

export function csrfCookieOptions(requestUrl: URL, maxAge: number) {
	return {
		httpOnly: false,
		path: '/',
		sameSite: 'lax' as const,
		secure: requestUrl.protocol === 'https:',
		maxAge,
	};
}
