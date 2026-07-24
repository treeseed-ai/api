import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('requires sensitive unlock and records project infrastructure cleanup status', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const { team, project } = await createTeamAndProject(app, token, {
			slug: 'delete-hosted',
			name: 'Delete Hosted',
			metadata: {
				cloudflareHost: {
					mode: 'team_owned',
					hostId: 'web-host-delete',
					dns: { zoneName: 'example.test' },
					domains: {
						manageDns: true,
						zoneName: 'example.test',
						productionDomain: 'delete-hosted.example.test',
						stagingDomain: 'delete-hosted-staging.example.test',
					},
				},
			},
		});
		await store.upsertRepositoryHost(team.id, {
			id: 'repo-host-delete',
			name: 'Delete GitHub',
			organizationOrOwner: 'treeseed-sites',
			ownership: 'team_owned',
			encryptedPayload: encryptedTestHostEnvelope({ TREESEED_GITHUB_TOKEN: 'github-token', organizationOrOwner: 'treeseed-sites' }, 'pass'),
		});
		await store.createTeamWebHost(team.id, {
			id: 'web-host-delete',
			name: 'Delete Cloudflare',
			provider: 'cloudflare',
			ownership: 'team_owned',
			encryptedPayload: encryptedTestHostEnvelope({ TREESEED_CLOUDFLARE_API_TOKEN: 'cloudflare-token', TREESEED_CLOUDFLARE_ACCOUNT_ID: 'account-1' }, 'pass'),
			metadata: {
				dns: { managed: true, zoneName: 'example.test' },
			},
		});
		await store.upsertHubRepository(project.id, {
			teamId: team.id,
			role: 'software',
			repositoryHostId: 'repo-host-delete',
			provider: 'github',
			owner: 'treeseed-sites',
			name: 'delete-hosted-site',
			defaultBranch: 'main',
			status: 'active',
			metadata: { create: true },
		});
		await store.upsertProjectEnvironment(project.id, {
			environment: 'staging',
			deploymentProfile: 'hosted_project',
			baseUrl: 'https://delete-hosted-staging.example.test',
			cloudflareAccountId: 'account-1',
			pagesProjectName: 'delete-hosted-site',
				workerName: 'delete-hosted-staging-worker',
				r2BucketName: 'delete-hosted-content',
				d1DatabaseName: 'delete-hosted-site-data',
			});
		await store.upsertProjectInfrastructureResource(project.id, {
			environment: 'staging',
			provider: 'cloudflare',
			resourceKind: 'kv',
			logicalName: 'form_guard',
			locator: 'kv-form-guard-id',
			metadata: {
				id: 'kv-form-guard-id',
				name: 'delete-hosted-form-guard',
				binding: 'FORM_GUARD_KV',
			},
		});
		await store.upsertProjectInfrastructureResource(project.id, {
			environment: 'staging',
			provider: 'cloudflare',
			resourceKind: 'turnstile-widget',
			logicalName: 'form_guard_turnstile',
			locator: 'turnstile-sitekey-1',
			metadata: {
				sitekey: 'turnstile-sitekey-1',
				name: 'delete-hosted-turnstile-staging',
				mode: 'managed',
			},
		});
		const headers = {
			'content-type': 'application/json',
			authorization: `Bearer ${token}`,
		};
		const locked = await json(await app.request(`/v1/projects/${project.id}`, {
			method: 'DELETE',
			headers,
			body: JSON.stringify({ confirmation: 'DELETE delete-hosted' }),
		}));
		expect(locked.ok).toBe(false);
		expect(locked.code).toBe('sensitive_passphrase_rejected');

		const rejected = await json(await app.request(`/v1/projects/${project.id}`, {
			method: 'DELETE',
			headers,
			body: JSON.stringify({ confirmation: 'DELETE delete-hosted', sensitivePassphrase: 'pass' }),
		}));
		expect(rejected.ok).toBe(false);
		expect(rejected.code).toBe('sensitive_passphrase_rejected');
		expect(await store.listProjectDeployments(project.id, { action: 'delete_project', limit: 10 })).toEqual([]);
	});
});
