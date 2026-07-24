import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('marks TreeSeed managed hosts active from existing platform provider env vars', async () => {
		await withEnv({
			TREESEED_CLOUDFLARE_API_TOKEN: 'platform-cloudflare-token',
			TREESEED_CLOUDFLARE_ACCOUNT_ID: 'platform-cloudflare-account',
			}, async () => {
			const app = createTestApp();
			const token = await authorizeApp(app);
			const team = await createTeam(app, token);

			const listed = await json(await app.request(`/v1/teams/${team.id}/hosts`, {
				headers: { authorization: `Bearer ${token}` },
				}));
				const web = listed.payload.find((host: any) => host.id === 'treeseed-managed-web');
				expect(web.status).toBe('active');
				expect(web.metadata.missingConfigKeys).toEqual([]);
				expect(JSON.stringify(listed)).not.toContain('platform-cloudflare-token');
			});
		});
});
