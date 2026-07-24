import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../support/api-harness.ts';

describe('market api', () => {
it('skips Cloudflare cleanup when launch failed before recording Cloudflare resources', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const { team, project } = await createTeamAndProject(app, token, {
			slug: 'delete-failed-launch',
			name: 'Delete Failed Launch',
			metadata: {
				launchPhase: 'failed',
				launchFailure: {
					code: 'api_bootstrap_failed',
					message: 'Cloudflare API request failed after 1 attempts: POST /zones/zone-1/dns_records: Authentication error',
				},
				cloudflareHost: {
					mode: 'team_owned',
					hostId: 'web-host-failed-launch',
					domains: {
						manageDns: true,
						zoneName: 'example.test',
						productionDomain: 'delete-failed-launch.example.test',
						stagingDomain: 'delete-failed-launch-staging.example.test',
					},
				},
			},
		});
		await store.upsertRepositoryHost(team.id, {
			id: 'repo-host-failed-launch',
			name: 'Failed Launch GitHub',
			organizationOrOwner: 'treeseed-sites',
			ownership: 'team_owned',
			encryptedPayload: encryptedTestHostEnvelope({ TREESEED_GITHUB_TOKEN: 'github-token', organizationOrOwner: 'treeseed-sites' }, 'pass'),
		});
		await store.createTeamWebHost(team.id, {
			id: 'web-host-failed-launch',
			name: 'Failed Launch Cloudflare',
			provider: 'cloudflare',
			ownership: 'team_owned',
			encryptedPayload: encryptedTestHostEnvelope({ TREESEED_CLOUDFLARE_API_TOKEN: 'bad-cloudflare-token', TREESEED_CLOUDFLARE_ACCOUNT_ID: 'account-1' }, 'pass'),
			metadata: { dns: { managed: true, zoneName: 'example.test' } },
		});
		await store.upsertHubRepository(project.id, {
			teamId: team.id,
			role: 'software',
			repositoryHostId: 'repo-host-failed-launch',
			provider: 'github',
			owner: 'treeseed-sites',
			name: 'delete-failed-launch-site',
			defaultBranch: 'main',
			status: 'queued',
			metadata: { create: true },
		});
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
			const url = String(input);
			const method = String(init.method ?? 'GET').toUpperCase();
			if (url.startsWith('https://api.github.com/') && method === 'DELETE') {
				return new Response(null, { status: 204 });
			}
			if (url.startsWith('https://api.cloudflare.com/')) {
				return new Response(JSON.stringify({
					success: false,
					errors: [{ code: 10000, message: 'Authentication error' }],
				}), { status: 403 });
			}
			return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
		});
		const started = await json(await app.request(`/v1/projects/${project.id}`, {
			method: 'DELETE',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ confirmation: 'DELETE delete-failed-launch', sensitivePassphrase: 'pass' }),
		}));
		expect(started.ok).toBe(false);
		expect(started.code).toBe('sensitive_passphrase_rejected');
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});
});
