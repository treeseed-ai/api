import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../support/api-harness.ts';

describe('market api', () => {
it('rejects team-owned Cloudflare launch before DNS preflight when unlock material is supplied', async () => {
		const fetchMock = mockCloudflareDnsPreflight({ createOk: false });
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);
		const passphrase = 'correct horse battery staple';
		const host = await json(await app.request(`/v1/teams/${team.id}/web-hosts`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Team Cloudflare DNS Limited',
				ownership: 'team_owned',
				metadata: {
					hostType: 'web',
					dns: { managed: true, zoneName: 'example.test', zoneId: 'zone-1' },
				},
				encryptedPayload: encryptedTestHostEnvelope({
					TREESEED_CLOUDFLARE_API_TOKEN: 'cf-secret-token',
					TREESEED_CLOUDFLARE_ACCOUNT_ID: 'account-1',
				}, passphrase),
			}),
		}));

		const launched = await app.request(`/v1/teams/${team.id}/projects/launch`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				slug: 'dns-limited-cloudflare',
				name: 'DNS Limited Cloudflare',
				sourceKind: 'blank',
				hostingMode: 'managed',
				cloudflareHostMode: 'team_owned',
				cloudflareHostId: host.payload.id,
				sensitivePassphrase: passphrase,
				targetEnvironments: ['staging', 'prod'],
				domains: {
					productionDomain: 'example.test',
					stagingDomain: 'staging.example.test',
					zoneName: 'example.test',
					zoneId: 'zone-1',
					manageDns: true,
				},
			}),
		});
		expect(launched.status).toBe(400);
		const payload = await json(launched);
		expect(payload.ok).toBe(false);
		expect(payload.code).toBe('sensitive_passphrase_rejected');
		const projects = await json(await app.request(`/v1/projects?teamId=${team.id}`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(projects.payload.find((project: { slug: string }) => project.slug === 'dns-limited-cloudflare')).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
