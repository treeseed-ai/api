import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { createApiApp } from '../../src/api/app.js';
import { createTreeDxCredentialBridge } from '../../src/api/treedx-credential-bridge.ts';
import { MarketPostgresDatabase } from '../../src/api/market-postgres.js';
import { MarketControlPlaneStore } from '../../src/api/store.js';

const packageRoot = process.cwd();
const marketMigrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market'))
	? resolve(packageRoot, '../sdk/drizzle/market')
	: resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');

function createTestPostgresDatabase() {
	const memory = newDb();
	memory.public.registerFunction({
		name: 'md5',
		args: [DataType.text],
		returns: DataType.text,
		implementation: (value: string) => `md5:${value}`,
	});
	const pg = memory.adapters.createPg();
	return MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot: marketMigrationRoot });
}

function createTestStore() {
	return new MarketControlPlaneStore({
		repoRoot: packageRoot,
		authSecret: 'test-secret',
		baseUrl: 'https://market.example.com',
		siteUrl: 'https://market.example.com',
		issuer: 'https://market.example.com',
		projectId: 'treeseed-market',
		projectApiKey: 'market-project-key',
		projectApiPermissions: ['sdk:execute:global', 'agent:execute:global', 'operations:execute:global'],
		serviceId: 'web',
		serviceSecret: 'web-test-secret',
		assertionSecret: 'web-assertion-secret',
	}, createTestPostgresDatabase());
}

function fakeGithubAppAdapter(calls: any[] = [], rawToken = 'ghs_treedx_transient_token') {
	return {
		mintInstallationToken: async (input: any) => {
			calls.push(input);
			if (input.repository === 'treeseed-ai/drifted') {
				const error = new Error('grant drifted');
				(error as any).code = 'github_grant_drifted';
				(error as any).status = 403;
				throw error;
			}
			return {
				token: rawToken,
				expiresAt: '2026-06-17T22:30:00.000Z',
				permissions: input.requiredPermissions,
				issuance: { id: 'github-token-issuance-1' },
			};
		},
	};
}

describe('TreeDX credential bridge', () => {
	it('issues short-lived GitHub App credentials while storing only evidence', async () => {
		const store = createTestStore();
		const calls: any[] = [];
		const rawToken = 'ghs_treedx_super_secret_installation_token';
		const bridge = createTreeDxCredentialBridge({
			store,
			githubAppAdapter: fakeGithubAppAdapter(calls, rawToken),
			now: () => new Date('2026-06-17T21:30:00.000Z'),
		});

		const credential = await bridge.issueGitCredential({
			teamId: 'team-1',
			projectId: 'project-1',
			repository: 'TreeSeed-AI/Project',
			installationId: '99',
			operation: 'push',
			credentialId: 'repo-write',
			ref: 'refs/heads/main',
			paths: ['src/index.ts'],
			assignmentId: 'assignment-1',
			providerId: 'provider-1',
			workdayId: 'workday-1',
			policy: {
				allowedRefs: ['refs/heads/main'],
				allowedPathPrefixes: ['src'],
				requireAssignment: true,
				requireProvider: true,
				requireWorkday: true,
			},
		});

		expect(calls[0]).toMatchObject({
			teamId: 'team-1',
			projectId: 'project-1',
			repository: 'treeseed-ai/project',
			installationId: '99',
			requiredPermissions: { contents: 'write', metadata: 'read' },
			allowedOperations: ['push'],
		});
		expect(credential).toMatchObject({
			id: 'repo-write',
			type: 'token',
			username: 'x-access-token',
			token: rawToken,
			provider: 'github-app',
			repository: 'treeseed-ai/project',
			allowedOperations: ['push'],
		});
		const issuance = await store.getTreeDxCredentialIssuanceRecord(credential.issuanceId);
		expect(issuance).toMatchObject({
			status: 'issued',
			tokenPrefix: rawToken.slice(0, 12),
			tokenHash: `sha256:${createHash('sha256').update(rawToken).digest('hex')}`,
			allowedOperations: ['push'],
		});
		const audit = await store.listAuditEventsForTarget('project', 'project-1', 20);
		expect(JSON.stringify({ issuance, audit })).not.toContain(rawToken);
		expect(JSON.stringify({ issuance, audit })).not.toContain('super_secret_installation_token');
	});

	it('fails closed before token issuance for invalid requests and drifted grants', async () => {
		const store = createTestStore();
		const calls: any[] = [];
		const bridge = createTreeDxCredentialBridge({
			store,
			githubAppAdapter: fakeGithubAppAdapter(calls),
		});

		await expect(bridge.issueGitCredential({
			teamId: 'team-1',
			projectId: 'project-1',
			repository: 'treeseed-ai/project',
			installationId: '99',
			operation: 'delete_everything',
		})).rejects.toMatchObject({ code: 'treedx_credential_revoked' });
		expect(calls).toHaveLength(0);

		await expect(bridge.issueGitCredential({
			teamId: 'team-1',
			projectId: 'project-1',
			repository: 'treeseed-ai/project',
			installationId: '99',
			operation: 'fetch',
			secretValue: 'do-not-store',
		} as any)).rejects.toMatchObject({ code: 'treedx_credential_revoked' });
		expect(calls).toHaveLength(0);

		await expect(bridge.issueGitCredential({
			teamId: 'team-1',
			projectId: 'project-1',
			repository: 'treeseed-ai/drifted',
			installationId: '99',
			operation: 'fetch',
		})).rejects.toMatchObject({ code: 'github_grant_drifted' });
	});

	it('exposes a service-authenticated internal route for TreeDX connected mode', async () => {
		const store = createTestStore();
		await store.upsertGitHubAppInstallationRecord({
			teamId: 'team-1',
			installationId: '99',
			accountLogin: 'team-1',
			accountId: '42',
			status: 'active',
			permissions: { contents: 'read', metadata: 'read' },
		});
		await store.upsertGitHubRepositoryGrant({
			teamId: 'team-1',
			projectId: 'project-1',
			repository: 'treeseed-ai/project',
			installationId: '99',
			status: 'active',
			permissions: { contents: 'read', metadata: 'read' },
		});
		const app = createApiApp({
			store,
			db: createTestPostgresDatabase(),
			config: {
				projectId: 'treeseed-market',
				repoRoot: packageRoot,
				webServiceId: 'treedx',
				webServiceSecret: 'bridge-secret',
			},
			githubAppAdapter: fakeGithubAppAdapter([], 'ghs_route_transient_token'),
		} as any);

		const denied = await app.request('/v1/internal/treedx/credentials/github-app', {
			method: 'POST',
			body: JSON.stringify({}),
		});
		expect(denied.status).toBe(401);

		const response = await app.request('/v1/internal/treedx/credentials/github-app', {
			method: 'POST',
			body: JSON.stringify({
				teamId: 'team-1',
				projectId: 'project-1',
				repository: 'treeseed-ai/project',
				installationId: '99',
				operation: 'fetch',
				credentialId: 'repo-read',
			}),
			headers: {
				'content-type': 'application/json',
				'x-treeseed-service-id': 'treedx',
				'x-treeseed-service-secret': 'bridge-secret',
			},
		});
		expect(response.status).toBe(201);
		const body = await response.json();
		expect(body.payload).toMatchObject({
			id: 'repo-read',
			type: 'token',
			username: 'x-access-token',
			token: 'ghs_route_transient_token',
			repository: 'treeseed-ai/project',
		});
		const audit = await store.listAuditEventsForTarget('project', 'project-1', 20);
		expect(JSON.stringify(audit)).not.toContain('ghs_route_transient_token');
	});
});
