import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('redirects legacy v1 browser approval links to the web approval page', async () => {
		const app = createTestApp({
			config: {
				baseUrl: 'https://api.treeseed.dev',
				siteUrl: 'https://treeseed.dev',
			},
		});

		const response = await app.request('/v1/auth/device/approve?user_code=ABCD-EFGH');

		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('https://treeseed.dev/auth/device/approve?user_code=ABCD-EFGH');
	});
});
