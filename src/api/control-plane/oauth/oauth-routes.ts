import type { Hono } from 'hono';
import { authorizationServerMetadata, isFirstPartyOAuthClient, normalizeRequestedScopes, protectedResourceMetadata } from './oauth-metadata.ts';
import { clientAllowsRedirect, resolveOAuthClient } from './oauth-clients.ts';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

interface DeviceStartResult {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	intervalSeconds: number;
	expiresInSeconds: number;
}

interface ApprovedTokenResult {
	status?: string;
	accessToken: string;
	refreshToken: string;
	tokenType: string;
	expiresInSeconds: number;
	principal?: { scopes?: string[] };
}

export interface OAuthRuntimeProvider {
	startDeviceFlow(request: { clientName: string; scopes: string[] }): Promise<DeviceStartResult>;
	approveDeviceFlow(request: { userCode: string; principalId: string; displayName?: string; metadata?: Record<string, unknown> }): Promise<{ ok: true }>;
	pollDeviceFlow(request: { deviceCode: string }): Promise<ApprovedTokenResult | { ok?: boolean; status: string; intervalSeconds?: number; error?: string }>;
	refreshAccessToken(request: { refreshToken: string }): Promise<ApprovedTokenResult>;
	startAuthorizationCode(request: { clientId: string; userId: string; redirectUri: string; codeChallenge: string; scopes: string[] }): Promise<{ code: string; expiresInSeconds: number }>;
	exchangeAuthorizationCode(request: { clientId: string; code: string; redirectUri: string; codeVerifier: string }): Promise<ApprovedTokenResult>;
	revokeOAuthToken(token: string): Promise<void>;
	authenticatePassword?(identifier: string, password: string): Promise<{ principal: { id: string; displayName?: string; scopes?: string[]; metadata?: Record<string, unknown> } } | null>;
}

type AuthenticateBearer = (token: string) => Promise<{ principal: { id: string; displayName?: string; scopes?: string[]; metadata?: Record<string, unknown> } } | null>;

async function requestBody(context: any): Promise<Record<string, unknown>> {
	const contentType = context.req.header('content-type') ?? '';
	if (contentType.includes('application/json')) return context.req.json().catch(() => ({}));
	const form = await context.req.parseBody().catch(() => ({}));
	return Object.fromEntries(Object.entries(form).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
}

function oauthError(context: any, status: number, error: string, description: string) {
	return context.json({ error, error_description: description }, status, {
		'cache-control': 'no-store',
		pragma: 'no-cache',
	});
}

function tokenResponse(context: any, result: ApprovedTokenResult) {
	return context.json({
		access_token: result.accessToken,
		refresh_token: result.refreshToken,
		token_type: result.tokenType,
		expires_in: result.expiresInSeconds,
		scope: result.principal?.scopes?.join(' '),
	}, 200, { 'cache-control': 'no-store', pragma: 'no-cache' });
}

function authorizedScopes(requested: string[], permitted: string[] | undefined) {
	const allowed = new Set(permitted ?? []);
	return requested.length > 0 && requested.every((scope) => allowed.has(scope));
}

function escapeHtml(value: unknown) {
	return String(value ?? '').replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function deviceApprovalPage(userCode: string, state: 'pending' | 'approved' | 'failed' = 'pending', message = '') {
	const title = state === 'approved' ? 'Device approved' : state === 'failed' ? 'Approval failed' : 'Approve TreeSeed CLI';
	const content = state === 'approved'
		? '<p class="success">The CLI has been approved. You may close this window and return to your terminal.</p>'
		: state === 'failed'
			? `<p class="error">${escapeHtml(message)}</p><p><a href="/auth/device/approve?user_code=${encodeURIComponent(userCode)}">Try again</a></p>`
			: `<p>Confirm this device code and authenticate with your TreeSeed account.</p><div class="code">${escapeHtml(userCode || 'Enter the code from the CLI')}</div><form method="post" action="/auth/device/approve"><label>Device code<input name="user_code" value="${escapeHtml(userCode)}" required autocomplete="one-time-code"></label><label>Email or username<input name="identifier" required autocomplete="username" autofocus></label><label>Password<input name="password" type="password" required autocomplete="current-password"></label><button type="submit">Approve CLI</button></form>`;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px system-ui,sans-serif;background:#f5f7f4;color:#172019;margin:0}main{max-width:32rem;margin:8vh auto;background:white;padding:2rem;border-radius:1rem;box-shadow:0 8px 30px #0002}h1{margin-top:0}.code{font:700 1.5rem ui-monospace,monospace;letter-spacing:.08em;padding:.8rem;background:#eef3ec;border-radius:.5rem;margin:1rem 0}label{display:block;margin:1rem 0;font-weight:600}input{box-sizing:border-box;width:100%;padding:.75rem;margin-top:.35rem;border:1px solid #9aa99d;border-radius:.4rem;font:inherit}button{padding:.75rem 1.1rem;border:0;border-radius:.4rem;background:#176b45;color:white;font:700 1rem system-ui;cursor:pointer}.error{color:#a21b1b}.success{color:#176b45;font-weight:600}</style></head><body><main><h1>${title}</h1>${content}</main></body></html>`;
}

export function installOAuthProtocolRoutes(app: Hono, provider?: OAuthRuntimeProvider, authenticateBearer?: AuthenticateBearer) {
	app.get('/.well-known/oauth-protected-resource/mcp', (context) => context.json(protectedResourceMetadata(context.req.url)));
	app.get('/.well-known/oauth-authorization-server', (context) => context.json(authorizationServerMetadata(context.req.url)));

	app.get('/auth/device/approve', (context) => context.html(deviceApprovalPage(context.req.query('user_code')?.trim() ?? ''), 200,
		{ 'cache-control': 'no-store', pragma: 'no-cache', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", 'x-frame-options': 'DENY' }));

	app.post('/auth/device/approve', async (context) => {
		if (!provider || !authenticateBearer) return oauthError(context, 503, 'temporarily_unavailable', 'OAuth device approval is not configured.');
		const contentType = context.req.header('content-type') ?? '';
		const htmlForm = contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data');
		const body = await requestBody(context);
		const authorization = context.req.header('authorization') ?? '';
		let authenticated = authorization.startsWith('Bearer ') ? await authenticateBearer(authorization.slice(7).trim()) : null;
		if (!authenticated && provider.authenticatePassword && typeof body.identifier === 'string' && typeof body.password === 'string') {
			authenticated = await provider.authenticatePassword(body.identifier, body.password).then((result) => result ? { principal: result.principal } : null);
		}
		if (!authenticated) {
			if (htmlForm) return context.html(deviceApprovalPage(String(body.user_code ?? ''), 'failed', 'The email, username, or password was not accepted.'), 401, { 'cache-control': 'no-store', pragma: 'no-cache' });
			return oauthError(context, 401, 'invalid_token', 'An authenticated user session is required.');
		}
		const userCode = String(body.user_code ?? body.userCode ?? '').trim();
		if (!userCode) return htmlForm ? context.html(deviceApprovalPage('', 'failed', 'The device code is required.'), 400) : oauthError(context, 400, 'invalid_request', 'user_code is required.');
		try {
			await provider.approveDeviceFlow({ userCode, principalId: authenticated.principal.id,
				displayName: authenticated.principal.displayName, metadata: authenticated.principal.metadata });
			return htmlForm ? context.html(deviceApprovalPage(userCode, 'approved'), 200, { 'cache-control': 'no-store', pragma: 'no-cache' })
				: context.json({ approved: true }, 200, { 'cache-control': 'no-store', pragma: 'no-cache' });
		} catch {
			return htmlForm ? context.html(deviceApprovalPage(userCode, 'failed', 'The device code is unknown, expired, or no longer pending.'), 400, { 'cache-control': 'no-store', pragma: 'no-cache' })
				: oauthError(context, 400, 'invalid_grant', 'The device code is unknown, expired, or no longer pending.');
		}
	});

	app.get('/oauth/authorize', async (context) => {
		const clientId = context.req.query('client_id')?.trim() ?? '';
		const redirectUri = context.req.query('redirect_uri')?.trim() ?? '';
		const challenge = context.req.query('code_challenge')?.trim() ?? '';
		const method = context.req.query('code_challenge_method')?.trim() ?? '';
		const { scopes, unsupported } = normalizeRequestedScopes(context.req.query('scope'));
		const client = await resolveOAuthClient(clientId).catch(() => null);
		if (!client || !clientAllowsRedirect(client, redirectUri)) return oauthError(context, 400, 'invalid_request', 'A registered client and allowed redirect_uri are required.');
		if (method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/u.test(challenge)) return oauthError(context, 400, 'invalid_request', 'PKCE S256 is required.');
		if (unsupported.length > 0) return oauthError(context, 400, 'invalid_scope', `Unsupported scopes: ${unsupported.join(', ')}`);
		return context.json({ consent_required: true, client_id: clientId, redirect_uri: redirectUri, scopes,
			state: context.req.query('state') ?? null }, 200, { 'cache-control': 'no-store', pragma: 'no-cache' });
	});

	app.post('/oauth/authorize', async (context) => {
		if (!provider || !authenticateBearer) return oauthError(context, 503, 'temporarily_unavailable', 'OAuth authorization is not configured.');
		const authorization = context.req.header('authorization') ?? '';
		const authenticated = authorization.startsWith('Bearer ') ? await authenticateBearer(authorization.slice(7).trim()) : null;
		if (!authenticated) return oauthError(context, 401, 'invalid_token', 'An authenticated user session is required.');
		const body = await requestBody(context);
		const clientId = String(body.client_id ?? '').trim();
		const redirectUri = String(body.redirect_uri ?? '').trim();
		const challenge = String(body.code_challenge ?? '').trim();
		const method = String(body.code_challenge_method ?? '').trim();
		const client = await resolveOAuthClient(clientId).catch(() => null);
		if (!client || !clientAllowsRedirect(client, redirectUri)) return oauthError(context, 400, 'invalid_request', 'A registered client and allowed redirect_uri are required.');
		if (String(body.response_type ?? '') !== 'code' || method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/u.test(challenge)) {
			return oauthError(context, 400, 'invalid_request', 'response_type=code and PKCE S256 are required.');
		}
		const { scopes, unsupported } = normalizeRequestedScopes(body.scope);
		if (unsupported.length > 0) return oauthError(context, 400, 'invalid_scope', `Unsupported scopes: ${unsupported.join(', ')}`);
		if (!authorizedScopes(scopes, authenticated.principal.scopes)) return oauthError(context, 403, 'invalid_scope', 'One or more requested scopes exceed the current user authority.');
		if (String(body.decision ?? '') !== 'approve') return oauthError(context, 400, 'access_denied', 'The user did not approve the requested scopes.');
		const issued = await provider.startAuthorizationCode({ clientId, userId: authenticated.principal.id, redirectUri, codeChallenge: challenge, scopes });
		return context.json({ code: issued.code, redirect_uri: redirectUri, state: body.state ?? null, expires_in: issued.expiresInSeconds },
			200, { 'cache-control': 'no-store', pragma: 'no-cache' });
	});

	app.post('/oauth/device_authorization', async (context) => {
		if (!provider) return oauthError(context, 503, 'temporarily_unavailable', 'OAuth device authorization is not configured.');
		const body = await requestBody(context);
		const clientId = String(body.client_id ?? '').trim();
		if (!isFirstPartyOAuthClient(clientId)) return oauthError(context, 401, 'invalid_client', 'The OAuth client is not registered.');
		const { scopes, unsupported } = normalizeRequestedScopes(body.scope);
		if (unsupported.length > 0) return oauthError(context, 400, 'invalid_scope', `Unsupported scopes: ${unsupported.join(', ')}`);
		const started = await provider.startDeviceFlow({ clientName: clientId, scopes });
		return context.json({
			device_code: started.deviceCode,
			user_code: started.userCode,
			verification_uri: started.verificationUri,
			verification_uri_complete: started.verificationUriComplete,
			expires_in: started.expiresInSeconds,
			interval: started.intervalSeconds,
		}, 200, { 'cache-control': 'no-store', pragma: 'no-cache' });
	});

	app.post('/oauth/token', async (context) => {
		if (!provider) return oauthError(context, 503, 'temporarily_unavailable', 'OAuth token issuance is not configured.');
		const body = await requestBody(context);
		const clientId = String(body.client_id ?? '').trim();
		const grantType = String(body.grant_type ?? '').trim();
		try {
			const client = await resolveOAuthClient(clientId).catch(() => null);
			if (!client || !client.grantTypes.includes(grantType)) return oauthError(context, 401, 'invalid_client', 'The OAuth client is not registered for this grant.');
			if (grantType === 'authorization_code') {
				const code = String(body.code ?? '').trim();
				const redirectUri = String(body.redirect_uri ?? '').trim();
				const codeVerifier = String(body.code_verifier ?? '').trim();
				if (!code || !client || !clientAllowsRedirect(client, redirectUri) || !/^[A-Za-z0-9._~-]{43,128}$/u.test(codeVerifier)) {
					return oauthError(context, 400, 'invalid_request', 'code, registered redirect_uri, and PKCE code_verifier are required.');
				}
				return tokenResponse(context, await provider.exchangeAuthorizationCode({ clientId, code, redirectUri, codeVerifier }));
			}
			if (grantType === DEVICE_GRANT) {
				const deviceCode = String(body.device_code ?? '').trim();
				if (!deviceCode) return oauthError(context, 400, 'invalid_request', 'device_code is required.');
				const result = await provider.pollDeviceFlow({ deviceCode });
				if (result.status === 'pending') return oauthError(context, 400, 'authorization_pending', 'The user has not completed authorization.');
				if (result.status === 'expired') return oauthError(context, 400, 'expired_token', 'The device code has expired.');
				if (result.status === 'already_used') return oauthError(context, 400, 'invalid_grant', 'The device code has already been used.');
				if (!('accessToken' in result)) return oauthError(context, 400, 'invalid_grant', result.error ?? 'The device code is invalid.');
				return tokenResponse(context, result);
			}
			if (grantType === 'refresh_token') {
				const refreshToken = String(body.refresh_token ?? '').trim();
				if (!refreshToken) return oauthError(context, 400, 'invalid_request', 'refresh_token is required.');
				return tokenResponse(context, await provider.refreshAccessToken({ refreshToken }));
			}
			return oauthError(context, 400, 'unsupported_grant_type', 'The requested OAuth grant is not supported.');
		} catch {
			return oauthError(context, 400, 'invalid_grant', 'The grant is invalid, expired, revoked, or already used.');
		}
	});

	app.post('/oauth/revoke', async (context) => {
		if (!provider) return oauthError(context, 503, 'temporarily_unavailable', 'OAuth revocation is not configured.');
		const body = await requestBody(context);
		const clientId = String(body.client_id ?? '').trim();
		const client = await resolveOAuthClient(clientId).catch(() => null);
		if (!client) return oauthError(context, 401, 'invalid_client', 'The OAuth client is not registered.');
		const token = String(body.token ?? '').trim();
		if (!token) return oauthError(context, 400, 'invalid_request', 'token is required.');
		await provider.revokeOAuthToken(token);
		return context.body(null, 200, { 'cache-control': 'no-store', pragma: 'no-cache' });
	});
}
