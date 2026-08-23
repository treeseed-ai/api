import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TreeDxDelegationAuthority } from '../../../src/api/control-plane/treedx/delegation-authority.ts';

function environment() {
	const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
	return {
		TREESEED_ENVIRONMENT: 'test',
		TREESEED_TREEDX_DELEGATION_PRIVATE_KEY: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
		TREESEED_TREEDX_DELEGATION_KEY_ID: 'treedx-test-1',
		TREESEED_TREEDX_JWT_ISSUER: 'https://api.test/treedx',
		TREESEED_TREEDX_JWT_AUDIENCE: 'treedx-test',
	} as NodeJS.ProcessEnv;
}

const input = {
	actorId: 'user-1', tenantId: 'team-1', projectId: 'project-1', connectionId: 'connection-1',
	scope: { repositoryIds: ['repo-1'], capabilities: ['files:read'], refs: ['main'], paths: ['docs/**'] },
};

describe('TreeDX delegation authority', () => {
	it('issues an audience-bound RS256 delegation for no more than 120 seconds', () => {
		const authority = new TreeDxDelegationAuthority(environment());
		const issued = authority.mint(input, 1_000);
		const [header, payload, signature] = issued.token.split('.');
		const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
		expect(claims).toMatchObject({ iss: 'https://api.test/treedx', aud: 'treedx-test', sub: 'user-1', exp: 1_120,
			treedx_repo_ids: ['repo-1'], treedx_capabilities: ['files:read'], treeseed_project_id: 'project-1' });
		expect(JSON.parse(Buffer.from(header!, 'base64url').toString('utf8'))).toMatchObject({ alg: 'RS256', kid: 'treedx-test-1' });
		expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), createPublicKey({ key: authority.currentJwk, format: 'jwk' }), Buffer.from(signature!, 'base64url'))).toBe(true);
	});

	it('reuses only an exact unexpired scope and keeps private key material out of JWKS', () => {
		const authority = new TreeDxDelegationAuthority(environment());
		const first = authority.mint(input, 1_000);
		expect(authority.mint(input, 1_050).token).toBe(first.token);
		expect(authority.mint({ ...input, scope: { ...input.scope, capabilities: ['files:write'] } }, 1_050).token).not.toBe(first.token);
		expect(authority.mint(input, 1_091).token).not.toBe(first.token);
		expect(JSON.stringify(authority.jwks())).not.toContain('PRIVATE');
		expect(authority.jwks().keys[0]).not.toHaveProperty('d');
	});
});
