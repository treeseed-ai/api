import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('rejects unauthenticated workday run mutation without local acceptance auth', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		try {
			await store.ensureInitialized();
			await store.createTeam({ id: 'treeseed', slug: 'treeseed', name: 'TreeSeed' });
			const app = createTestApp({
				db,
				store,
				config: {
					environment: 'staging',
					capacityGovernanceSecret: 'test-capacity-governance-secret-123',
				},
			});
			const response = await app.request('/v1/teams/treeseed/workday-runs', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id: 'run-hosted-denied', status: 'running' }),
			});
			expect(response.status).toBe(401);
		} finally {
			db.close();
		}
	});
});
