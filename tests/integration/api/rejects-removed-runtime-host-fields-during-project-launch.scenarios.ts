import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

const { executeKnowledgeHubProviderLaunch: executeKnowledgeHubProviderLaunchMock } = getApiMocks();

describe('market api', () => {
it('rejects removed runtime host fields during project launch', async () => {
			await withEnv({
				TREESEED_CLOUDFLARE_API_TOKEN: 'managed-token',
				TREESEED_CLOUDFLARE_ACCOUNT_ID: 'managed-account',
			}, async () => {
				executeKnowledgeHubProviderLaunchMock.mockRejectedValue(new Error('launch intentionally stopped'));
				const app = createTestApp();
			const token = await authorizeApp(app);
			const team = await createTeam(app, token);

			const launched = await app.request(`/v1/teams/${team.id}/projects/launch`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					slug: 'hosted-with-capacity-provider',
					name: 'Hosted With Capacity Provider',
						sourceKind: 'blank',
						hostingMode: 'managed',
						cloudflareHostMode: 'treeseed_managed',
						processingHostMode: 'treeseed_managed',
						processingHostId: 'treeseed-managed-runtime',
					}),
				});
				expect(launched.status).toBe(400);
				const launchPayload = await json(launched);
				expect(launchPayload.error).toMatch(/no longer accepts runtime host configuration/u);
				expect(executeKnowledgeHubProviderLaunchMock).not.toHaveBeenCalled();
		});
	});
});
