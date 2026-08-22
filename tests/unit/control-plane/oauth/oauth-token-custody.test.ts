import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { issueUserSessionMethod } from '../../../../src/api/auth/postgres-store/accounts/sessions/issue-user-session.ts';
import { authenticateBearerTokenMethod } from '../../../../src/api/auth/postgres-store/accounts/tokens/authenticate-bearer-token.ts';
import { refreshAccessTokenMethod } from '../../../../src/api/auth/postgres-store/accounts/tokens/refresh-access-token.ts';
import { revokeOAuthTokenMethod } from '../../../../src/api/auth/postgres-store/accounts/tokens/revoke-oauth-token.ts';
import { exchangeTrustedUserAssertionMethod } from '../../../../src/api/auth/postgres-store/support/principals/exchange-trusted-user-assertion.ts';
import { exchangeAuthorizationCodeMethod } from '../../../../src/api/auth/postgres-store/runtime/exchange-authorization-code.ts';
import { startAuthorizationCodeMethod } from '../../../../src/api/auth/postgres-store/runtime/start-authorization-code.ts';
import { startDeviceFlowMethod } from '../../../../src/api/auth/postgres-store/runtime/start-device-flow.ts';

const principal = {
	id: 'user-a', displayName: 'User A', scopes: ['treeseed:read'], roles: ['member'], permissions: [], metadata: {},
};

const config = {
	authSecret: 'test-auth-secret', accessTokenTtlSeconds: 900, refreshTokenTtlSeconds: 86_400,
	webExchangeTtlSeconds: 300, webServiceId: 'site-bff', issuer: 'https://api.example.test',
};

function opaque(value: string, prefix: string) {
	expect(value).toMatch(new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`, 'u'));
	expect(value).not.toContain('.');
}

describe('OAuth token custody', () => {
	it('stores only hashes for opaque access and refresh tokens', async () => {
		const writes: Array<{ query: string; params: unknown[] }> = [];
		const store = {
			config, ensureInitialized: vi.fn(), principalForUser: vi.fn(async () => ({ principal })),
			run: vi.fn(async (query: string, params: unknown[]) => { writes.push({ query, params }); }),
			writeAuditEvent: vi.fn(),
		};
		const result = await issueUserSessionMethod.call(store as never, 'user-a', { scopes: ['treeseed:read'] });
		opaque(result.accessToken, 'access');
		opaque(result.refreshToken, 'refresh');
		const insert = writes.find(({ query }) => query.includes('INSERT INTO auth_sessions'))!;
		expect(insert.query).toContain('access_token_hash');
		expect(insert.query).toContain('access_expires_at');
		expect(insert.params).not.toContain(result.accessToken);
		expect(insert.params).not.toContain(result.refreshToken);
	});

	it('rotates refresh and access hashes with one compare-and-swap', async () => {
		const queries: Array<{ query: string; params: unknown[] }> = [];
		const store = {
			config, ensureInitialized: vi.fn(), principalForUser: vi.fn(async () => ({ principal })),
			async first(query: string, params: unknown[]) {
				queries.push({ query, params });
				return query.startsWith('UPDATE') ? { id: 'session-a' } : {
					id: 'session-a', user_id: 'user-a', scopes_json: '["treeseed:read"]', expires_at: '2099-01-01T00:00:00.000Z',
				};
			},
		};
		const result = await refreshAccessTokenMethod.call(store as never, { refreshToken: 'refresh_original' });
		opaque(result.accessToken, 'access');
		opaque(result.refreshToken, 'refresh');
		const update = queries.find(({ query }) => query.startsWith('UPDATE'))!;
		expect(update.query).toContain('AND refresh_token_hash = ?');
		expect(update.query).toContain('RETURNING id');
		expect(update.params).not.toContain('refresh_original');
		expect(update.params).not.toContain(result.accessToken);
		expect(update.params).not.toContain(result.refreshToken);
	});

	it('authenticates opaque access tokens by stored hash and current principal state', async () => {
		const lookups: Array<{ query: string; params: unknown[] }> = [];
		const store = {
			config, ensureInitialized: vi.fn(), principalForUser: vi.fn(async () => ({ principal })), run: vi.fn(),
			async first(query: string, params: unknown[]) {
				lookups.push({ query, params });
				if (query.includes('FROM api_tokens')) return null;
				return { id: 'session-a', user_id: 'user-a', scopes_json: '["treeseed:read"]',
					access_expires_at: '2099-01-01T00:00:00.000Z', revoked_at: null, data_json: '{}' };
			},
		};
		const authenticated = await authenticateBearerTokenMethod.call(store as never, 'access_secret');
		expect(authenticated).toMatchObject({ principal: { id: 'user-a' }, credential: { type: 'access_token', id: 'session-a' } });
		expect(lookups.at(-1)?.query).toContain('access_token_hash = ?');
		expect(lookups.flatMap(({ params }) => params)).not.toContain('access_secret');
	});

	it('stores short-lived site delegation as a revocable opaque credential', async () => {
		const writes: Array<{ query: string; params: unknown[] }> = [];
		const store = {
			config, ensureInitialized: vi.fn(), principalForUser: vi.fn(async () => ({ principal })),
			run: vi.fn(async (query: string, params: unknown[]) => { writes.push({ query, params }); }), writeAuditEvent: vi.fn(),
		};
		const result = await exchangeTrustedUserAssertionMethod.call(store as never, {
			userId: 'user-a', sessionId: 'web-a', expiresAt: '2099-01-01T00:00:00.000Z', authTime: '2099-01-01T00:00:00.000Z',
		});
		opaque(result.accessToken, 'delegation');
		const insert = writes.find(({ query }) => query.includes('INSERT INTO api_tokens'))!;
		expect(insert.query).toContain("'delegation'");
		expect(insert.params).not.toContain(result.accessToken);
	});

	it('revokes OAuth token hashes without revoking personal access tokens', async () => {
		const writes: Array<{ query: string; params: unknown[] }> = [];
		const store = { config, ensureInitialized: vi.fn(), run: vi.fn(async (query: string, params: unknown[]) => { writes.push({ query, params }); }) };
		await revokeOAuthTokenMethod.call(store as never, 'access_secret');
		expect(writes).toHaveLength(2);
		expect(writes[0].query).toContain('access_token_hash = ? OR refresh_token_hash = ?');
		expect(writes[1].query).toContain("kind <> 'personal_access_token'");
		expect(writes.flatMap(({ params }) => params)).not.toContain('access_secret');
	});

	it('stores authorization codes by hash with exact client, redirect, scopes, and PKCE challenge', async () => {
		const writes: Array<{ query: string; params: unknown[] }> = [];
		const store = { config, ensureInitialized: vi.fn(), run: vi.fn(async (query: string, params: unknown[]) => { writes.push({ query, params }); }) };
		const result = await startAuthorizationCodeMethod.call(store as never, { clientId: 'trsd', userId: 'user-a',
			redirectUri: 'http://127.0.0.1:8765/callback', codeChallenge: 'challenge-a', scopes: ['treeseed:read'] });
		opaque(result.code, 'code');
		expect(writes[0].params).not.toContain(result.code);
		expect(writes[0].params).toEqual(expect.arrayContaining(['trsd', 'user-a', 'http://127.0.0.1:8765/callback', 'challenge-a']));
	});

	it('stores the device credential by hash and generates a cryptographic user code', async () => {
		const writes: Array<{ query: string; params: unknown[] }> = [];
		const store = { config: { ...config, baseUrl: 'http://127.0.0.1:3002', deviceCodeTtlSeconds: 600, deviceCodePollIntervalSeconds: 5 },
			ensureInitialized: vi.fn(), run: vi.fn(async (query: string, params: unknown[]) => { writes.push({ query, params }); }) };
		const result = await startDeviceFlowMethod.call(store as never, { clientName: 'trsd', scopes: ['treeseed:read'] });
		opaque(result.deviceCode, 'device');
		expect(result.userCode).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/u);
		expect(writes[0].query).toContain('device_code_hash');
		expect(writes[0].params).not.toContain(result.deviceCode);
	});

	it('consumes a matching PKCE code once before issuing the bound session', async () => {
		const verifier = 'a'.repeat(43);
		const challenge = createHash('sha256').update(verifier).digest('base64url');
		const issueUserSession = vi.fn(async () => ({ ok: true }));
		let updateSucceeds = true;
		const store = { config, ensureInitialized: vi.fn(), issueUserSession,
			async first(query: string) {
				if (query.startsWith('UPDATE')) return updateSucceeds ? { id: 'code-a' } : null;
				return { id: 'code-a', client_id: 'trsd', user_id: 'user-a', redirect_uri: 'http://127.0.0.1:8765/callback',
					code_challenge: challenge, scopes_json: '["treeseed:read"]', expires_at: '2099-01-01T00:00:00.000Z', used_at: null };
			} };
		await exchangeAuthorizationCodeMethod.call(store as never, { clientId: 'trsd', code: 'code_secret',
			redirectUri: 'http://127.0.0.1:8765/callback', codeVerifier: verifier });
		expect(issueUserSession).toHaveBeenCalledWith('user-a', expect.objectContaining({ sessionType: 'authorization_code',
			data: { clientId: 'trsd', redirectUri: 'http://127.0.0.1:8765/callback' } }));
		updateSucceeds = false;
		await expect(exchangeAuthorizationCodeMethod.call(store as never, { clientId: 'trsd', code: 'code_secret',
			redirectUri: 'http://127.0.0.1:8765/callback', codeVerifier: verifier })).rejects.toThrow('replay');
	});
});
