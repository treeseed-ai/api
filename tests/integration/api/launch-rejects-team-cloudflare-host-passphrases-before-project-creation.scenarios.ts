import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('launch rejects team Cloudflare host passphrases before project creation', async () => {
		const fetchMock = mockCloudflareDnsPreflight();
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
				name: 'Team Cloudflare',
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
				slug: 'hosted-with-team-cloudflare',
				name: 'Hosted With Team Cloudflare',
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
		const launchPayload = await json(launched);
		expect(JSON.stringify(launchPayload)).not.toContain('cf-secret-token');
		expect(JSON.stringify(launchPayload)).not.toContain(passphrase);
		expect(launchPayload.ok).toBe(false);
		expect(launchPayload.code).toBe('sensitive_passphrase_rejected');
		const projects = await json(await app.request(`/v1/projects?teamId=${team.id}`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(projects.payload.find((project: { slug: string }) => project.slug === 'hosted-with-team-cloudflare')).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
