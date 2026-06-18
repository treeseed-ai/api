import { createHash, createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { createApiApp } from '../../src/api/app.js';
import { createGitHubAppAdapter } from '../../src/api/github-app-adapter.ts';
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

function fakeAppClient(installation: any) {
	return {
		request: async () => ({ data: installation }),
	};
}

function fakeInstallationClient(repositories: any[]) {
	return {
		paginate: async () => repositories,
	};
}

describe('GitHub App adapter', () => {
	it('observes installations and repository grants through the existing grant store', async () => {
		const store = createTestStore();
		const adapter = createGitHubAppAdapter({
			store,
			config: {
				githubAppId: '12345',
				githubAppPrivateKey: Buffer.from('-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----').toString('base64'),
			},
			githubAppClientFactory: () => fakeAppClient({
				id: 99,
				account: { login: 'team-1', id: 42, type: 'Organization' },
				permissions: { contents: 'write', metadata: 'read', actions: 'write' },
				repository_selection: 'selected',
				app_slug: 'treeseed',
			}),
			installationClientFactory: () => fakeInstallationClient([
				{
					full_name: 'TreeSeed-AI/Project',
					permissions: { contents: 'write', metadata: 'read', actions: 'write' },
				},
			]),
		});

		const result = await adapter.discoverRepositoryGrants({
			teamId: 'team-1',
			projectId: 'project-1',
			installationId: '99',
			requiredPermissions: { contents: 'write', metadata: 'read' },
		});

		expect(result.installation).toMatchObject({
			teamId: 'team-1',
			installationId: '99',
			accountLogin: 'team-1',
			accountId: '42',
			status: 'active',
		});
		expect(result.grants).toHaveLength(1);
		expect(result.grants[0]).toMatchObject({
			teamId: 'team-1',
			projectId: 'project-1',
			repository: 'treeseed-ai/project',
			status: 'active',
		});
	});

	it('fails closed for removed repositories, permission drift, account mismatches, and policy rejections', async () => {
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
			accountLogin: 'team-1',
			accountId: '42',
			status: 'active',
			permissions: { contents: 'read', metadata: 'read' },
		});
		let tokenCalls = 0;
		const adapter = createGitHubAppAdapter({
			store,
			config: { githubAppId: '12345', githubAppPrivateKey: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----' },
			installationTokenFactory: async () => {
				tokenCalls += 1;
				return { token: 'ghs_should_not_be_minted' };
			},
		});

		await expect(adapter.mintInstallationToken({
			teamId: 'team-1',
			projectId: 'project-1',
			installationId: '99',
			repository: 'treeseed-ai/project',
			accountId: '43',
			requiredPermissions: { contents: 'read' },
		})).rejects.toMatchObject({ code: 'github_account_mismatch' });

		await expect(adapter.mintInstallationToken({
			teamId: 'team-1',
			projectId: 'project-1',
			installationId: '99',
			repository: 'treeseed-ai/project',
			requiredPermissions: { contents: 'write' },
		})).rejects.toMatchObject({ code: 'github_permission_drift' });

		await store.updateGitHubRepositoryGrantStatus('team-1:treeseed-ai-project', 'drifted', {
			driftCode: 'github_repository_removed',
		});
		await expect(adapter.mintInstallationToken({
			teamId: 'team-1',
			projectId: 'project-1',
			installationId: '99',
			repository: 'treeseed-ai/project',
			requiredPermissions: { metadata: 'read' },
		})).rejects.toMatchObject({ code: 'github_grant_drifted' });

		await store.upsertGitHubRepositoryGrant({
			teamId: 'team-1',
			projectId: 'project-1',
			repository: 'treeseed-ai/project',
			installationId: '99',
			status: 'active',
			permissions: { contents: 'write', metadata: 'read' },
		});
		await expect(adapter.mintInstallationToken({
			teamId: 'team-1',
			projectId: 'project-1',
			installationId: '99',
			repository: 'treeseed-ai/project',
			requiredPermissions: { contents: 'write' },
			policy: { requireAssignment: true },
		})).rejects.toMatchObject({ code: 'github_app_token_blocked' });

		expect(tokenCalls).toBe(0);
	});

	it('mints short-lived tokens while storing only hash and prefix evidence', async () => {
		const store = createTestStore();
		await store.upsertGitHubAppInstallationRecord({
			teamId: 'team-1',
			installationId: '99',
			accountLogin: 'team-1',
			accountId: '42',
			status: 'active',
			permissions: { contents: 'write', metadata: 'read' },
		});
		await store.upsertGitHubRepositoryGrant({
			teamId: 'team-1',
			projectId: 'project-1',
			repository: 'treeseed-ai/project',
			installationId: '99',
			status: 'active',
			permissions: { contents: 'write', metadata: 'read' },
		});
		const rawToken = 'ghs_super_secret_installation_token';
		const adapter = createGitHubAppAdapter({
			store,
			config: { githubAppId: '12345', githubAppPrivateKey: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----' },
			installationTokenFactory: async () => ({
				token: rawToken,
				expiresAt: '2026-06-17T22:30:00.000Z',
				permissions: { contents: 'write', metadata: 'read' },
			}),
			now: () => new Date('2026-06-17T21:30:00.000Z'),
		});

		const result = await adapter.mintInstallationToken({
			teamId: 'team-1',
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			providerId: 'provider-1',
			workdayId: 'workday-1',
			operationId: 'repo-save',
			installationId: '99',
			repository: 'treeseed-ai/project',
			ref: 'refs/heads/main',
			paths: ['src/index.ts'],
			requiredPermissions: { contents: 'write', metadata: 'read' },
			allowedOperations: ['clone', 'fetch', 'commit', 'push'],
			policy: {
				requireAssignment: true,
				requireProvider: true,
				requireWorkday: true,
				allowedRefs: ['refs/heads/main'],
				allowedPathPrefixes: ['src'],
			},
		});

		expect(result.token).toBe(rawToken);
		expect(result.issuance).toMatchObject({
			status: 'issued',
			tokenPrefix: rawToken.slice(0, 12),
			tokenHash: `sha256:${createHash('sha256').update(rawToken).digest('hex')}`,
			expiresAt: '2026-06-17T22:30:00.000Z',
		});
		const records = await store.listGitHubAppTokenIssuanceRecords({ teamId: 'team-1' });
		const audit = await store.listAuditEventsForTarget('project', 'project-1', 50);
		expect(JSON.stringify({ records, audit })).not.toContain(rawToken);
		expect(JSON.stringify({ records, audit })).not.toContain('super_secret_installation_token');
	});

	it('validates and applies the real GitHub App webhook endpoint without trusting invalid signatures', async () => {
		const store = createTestStore();
		await store.upsertGitHubRepositoryGrant({
			teamId: 'team-1',
			projectId: 'project-1',
			repository: 'treeseed-ai/project',
			installationId: '99',
			status: 'active',
			permissions: { contents: 'write' },
		});
		const app = createApiApp({
			store,
			db: createTestPostgresDatabase(),
			config: {
				projectId: 'treeseed-market',
				repoRoot: packageRoot,
				githubAppWebhookSecret: 'webhook-secret',
			},
		});
		const payload = JSON.stringify({
			action: 'deleted',
			installation: {
				id: 99,
				account: { login: 'team-1', id: 42, type: 'Organization' },
				permissions: { contents: 'write' },
			},
		});
		const signature = `sha256=${createHmac('sha256', 'webhook-secret').update(payload).digest('hex')}`;

		const invalid = await app.request('/v1/internal/github/app/webhook', {
			method: 'POST',
			body: payload,
			headers: {
				'x-github-event': 'installation',
				'x-hub-signature-256': 'sha256=invalid',
			},
		});
		expect(invalid.status).toBe(401);
		expect(await store.getGitHubAppInstallationRecord({ teamId: 'team-1', installationId: '99' })).toBeNull();

		const valid = await app.request('/v1/internal/github/app/webhook', {
			method: 'POST',
			body: payload,
			headers: {
				'x-github-event': 'installation',
				'x-hub-signature-256': signature,
			},
		});
		expect(valid.status).toBe(200);
		const installation = await store.getGitHubAppInstallationRecord({ teamId: 'team-1', installationId: '99' });
		const grants = await store.listGitHubRepositoryGrants({ teamId: 'team-1' });
		expect(installation).toMatchObject({
			status: 'revoked',
			driftCode: 'github_installation_revoked',
		});
		expect(grants[0]).toMatchObject({
			status: 'revoked',
			driftCode: 'github_installation_revoked',
		});
	});
});
