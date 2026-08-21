import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { resolveGitHubCredentialAuthority } from '../../../src/security/provider-credential-authority.ts';

const row = (overrides: Record<string, unknown> = {}) => ({
	id: 'authority-1', team_id: 'team-1', connection_id: 'connection-1', credential_profile_id: 'github-repository-app',
	scheme: 'environment-reference', reference: 'TREESEED_GITHUB_TOKEN_TREESEED_AI_ADMIN',
	capabilities_json: '["repository-hosting"]', status: 'ready', provider_id: 'github', authority_id: 'authority-1',
	owner: 'treeseed-ai', name: 'admin',
	non_secret_config_json: '{"githubConnectors":{"repository":{"installationId":"42"}}}', ...overrides,
});

describe('provider credential authority', () => {
	it('uses only the explicitly persisted environment reference', async () => {
		const store = { first: vi.fn().mockResolvedValue(row()) };
		const credential = await resolveGitHubCredentialAuthority({
			store, authorityId: 'authority-1', repositoryBindingId: 'binding-1', capability: 'repository-hosting',
			env: { TREESEED_GITHUB_TOKEN: 'broad', TREESEED_GITHUB_TOKEN_TREESEED_AI_ADMIN: 'scoped' },
		});
		expect(credential).toMatchObject({ token: 'scoped', authorityScheme: 'environment-reference' });
		await expect(resolveGitHubCredentialAuthority({
			store, authorityId: 'authority-1', repositoryBindingId: 'binding-1', capability: 'repository-hosting',
			env: { TREESEED_GITHUB_TOKEN: 'broad' },
		})).rejects.toThrow(/explicit credential environment reference/u);
	});

	it('mints a repository-narrowed installation token with the Repository Connector', async () => {
		const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
		const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
		const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: 'installation-token', expires_at: '2026-08-01T23:00:00Z' }), { status: 201 }));
		const store = { first: vi.fn().mockResolvedValue(row({ scheme: 'app-installation', reference: 'managed-repository-connector' })) };
		const credential = await resolveGitHubCredentialAuthority({
			store, authorityId: 'authority-1', repositoryBindingId: 'binding-1', capability: 'repository-hosting', fetchImpl,
			env: { TREESEED_GITHUB_REPOSITORY_APP_ID: '7', TREESEED_GITHUB_REPOSITORY_APP_PRIVATE_KEY: pem },
		});
		expect(credential.token).toBe('installation-token');
		const request = fetchImpl.mock.calls[0];
		expect(request[0]).toContain('/app/installations/42/access_tokens');
		expect(JSON.parse(request[1].body)).toEqual({ repositories: ['admin'], permissions: { checks: 'read', contents: 'write' } });
		expect(JSON.stringify(request)).not.toContain(pem);
	});

	it('rejects a capability outside the persisted authority grant', async () => {
		const store = { first: vi.fn().mockResolvedValue(row()) };
		await expect(resolveGitHubCredentialAuthority({
			store, authorityId: 'authority-1', repositoryBindingId: 'binding-1', capability: 'workflow-execution',
			env: { TREESEED_GITHUB_TOKEN_TREESEED_AI_ADMIN: 'scoped' },
		})).rejects.toThrow(/does not grant/u);
	});
});
