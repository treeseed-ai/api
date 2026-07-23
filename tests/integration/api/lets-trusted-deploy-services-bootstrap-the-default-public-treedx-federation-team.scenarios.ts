import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('lets trusted deploy services bootstrap the default public TreeDX federation team', async () => {
		const app = createTestApp({
			config: {
				webServiceId: 'web',
				webServiceSecret: 'web-test-secret',
			},
		});
		const response = await app.request('/v1/internal/treedx/public-federation/provision', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-treeseed-service-id': 'web',
				'x-treeseed-service-secret': 'web-test-secret',
			},
			body: JSON.stringify({ imageRef: 'treeseed/treedx:0.1.0', idempotencyKey: 'test-public-treedx-bootstrap' }),
		});
		expect(response.status).toBe(202);
		const payload = await json(response);
		expect(payload.payload.team).toMatchObject({
			id: 'team-treeseed-public',
			slug: 'treeseed-public',
		});
		expect(payload.payload.instance).toMatchObject({
			teamId: 'team-treeseed-public',
			kind: 'managed_public_federation',
			provider: 'railway',
			publicRead: true,
			status: 'pending',
			volumeMountPath: '/data',
		});
		expect(payload.payload.operation).toMatchObject({
			namespace: 'treedx',
			operation: 'provision',
			status: 'queued',
		});

		const status = await json(await app.request('/v1/internal/treedx/public-federation/status?teamSlug=treeseed-public', {
			headers: {
				'x-treeseed-service-id': 'web',
				'x-treeseed-service-secret': 'web-test-secret',
			},
		}));
		expect(status.payload.team).toMatchObject({ id: 'team-treeseed-public' });
		expect(status.payload.deployments[0]).toMatchObject({ status: 'queued', provider: 'railway' });
	});
});
