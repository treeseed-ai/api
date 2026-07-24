import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../support/api-harness.ts';

describe('market api', () => {
it('logs local API request URLs with sensitive query values redacted', async () => {
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const app = createTestApp({ logRequests: true });

		const response = await app.request('/v1/markets/current?token=secret-token&teamId=team-1');

		expect(response.status).toBe(200);
		expect(write).toHaveBeenCalledWith(expect.stringContaining('[api] GET /v1/markets/current?token=[redacted]&teamId=team-1 -> 200'));
	});
});
