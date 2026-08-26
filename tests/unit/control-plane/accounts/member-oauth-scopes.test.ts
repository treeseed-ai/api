import { describe, expect, it } from 'vitest';
import { scopesForPrincipalMethod } from '../../../../src/api/auth/postgres-store/support/principals/scopes-for-principal.ts';

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
