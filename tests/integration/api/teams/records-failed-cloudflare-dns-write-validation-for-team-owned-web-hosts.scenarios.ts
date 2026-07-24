import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../support/api-harness.ts';

describe('market api', () => {
it('records failed Cloudflare DNS write validation for team-owned web hosts', async () => {
		mockCloudflareDnsPreflight({ createOk: false });
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);
		const created = await json(await app.request(`/v1/teams/${team.id}/web-hosts`, {
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
				encryptedPayload: encryptedHostEnvelope(),
			}),
		}));

		const validated = await json(await app.request(`/v1/teams/${team.id}/web-hosts/${created.payload.id}/validate`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				decryptedConfig: {
					TREESEED_CLOUDFLARE_API_TOKEN: 'cf-secret-token',
					TREESEED_CLOUDFLARE_ACCOUNT_ID: 'account-1',
				},
			}),
		}));
		expect(validated.payload.validation.status).toBe('failed');
		expect(validated.payload.validation.message).toContain('Cloudflare DNS write preflight failed');
		expect(validated.payload.validation.message).toContain('DNS Write and Zone Read access');
		expect(JSON.stringify(validated)).not.toContain('cf-secret-token');
	});
});
