import { describe, expect, it, vi } from 'vitest';
import { issueUserSessionMethod } from '../../../../src/api/auth/postgres-store/accounts/sessions/issue-user-session.ts';
import { authenticateBearerTokenMethod } from '../../../../src/api/auth/postgres-store/accounts/tokens/authenticate-bearer-token.ts';
import { refreshAccessTokenMethod } from '../../../../src/api/auth/postgres-store/accounts/tokens/refresh-access-token.ts';
import { revokeOAuthTokenMethod } from '../../../../src/api/auth/postgres-store/accounts/tokens/revoke-oauth-token.ts';
import { exchangeTrustedUserAssertionMethod } from '../../../../src/api/auth/postgres-store/support/principals/exchange-trusted-user-assertion.ts';

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
});
