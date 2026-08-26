import { describe, expect, it } from 'vitest';
import { scopesForPrincipalMethod } from '../../../../src/api/auth/postgres-store/support/principals/scopes-for-principal.ts';
import { principalForUserMethod } from '../../../../src/api/auth/postgres-store/support/principals/principal-for-user.ts';

describe('member OAuth scopes', () => {
	it('allows a registered member to manage their account and create a first team', () => {
		expect(scopesForPrincipalMethod.call({} as never, [
			'auth:read:self',
			'api_tokens:create:self',
		])).toEqual(expect.arrayContaining(['treeseed:read', 'treeseed:projects:write']));
	});

	it('keeps read-only viewers out of delegated mutations', () => {
		expect(scopesForPrincipalMethod.call({} as never, ['auth:read:self'])).toEqual(['treeseed:read']);
	});
});

describe('account appearance projection', () => {
	it('projects durable appearance preferences into authenticated principals', async () => {
		const principal = await principalForUserMethod.call({
			loadUser: async () => ({ id: 'user-1', display_name: 'User', email: 'user@example.test', metadata_json: '{}' }),
			rolesForUser: async () => ['member'], permissionsForUser: async () => ['api_tokens:create:self'],
			first: async () => ({ color_scheme: 'fern', theme_mode: 'dark' }),
			scopesForPrincipal: () => ['treeseed:read', 'treeseed:projects:write'],
		} as never, 'user-1');
		expect(principal.principal.metadata?.appearance).toEqual({ scheme: 'fern', mode: 'dark' });
	});
});
