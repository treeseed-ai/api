import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('queues public federation provisioning instead of treating it as a metadata-only attachment', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);

		const response = await app.request(`/v1/teams/${team.id}/treedx/provision`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ publicRead: true, imageRef: 'treeseed/treedx:0.1.0' }),
		});
		expect(response.status).toBe(202);
		const payload = await json(response);
		expect(payload.payload.instance).toMatchObject({
			teamId: team.id,
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
			input: expect.objectContaining({ publicRead: true, volumeMountPath: '/data' }),
		});
		expect(payload.payload.deployments[0]).toMatchObject({
			provider: 'railway',
			status: 'queued',
			volumeMountPath: '/data',
		});
	});
});
