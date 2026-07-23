import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('blocks dispatch when a project capability grant is disabled', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const { project } = await createTeamAndProject(app, token, {
			id: 'disabled-project',
			slug: 'disabled-project',
			name: 'Disabled Project',
		});

		await app.request(`/v1/projects/${project.id}/capabilities`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				grants: [{
					namespace: 'sdk',
					operation: 'refreshGraph',
					executionClass: 'remote_job',
					allowedTargets: ['project_runner'],
					defaultDispatchMode: 'prefer_remote',
					enabled: false,
				}],
			}),
		});

		const dispatched = await app.request(`/v1/projects/${project.id}/dispatch`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				namespace: 'sdk',
				operation: 'refreshGraph',
				input: {},
			}),
		});

		expect(dispatched.status).toBe(403);
		expect(await json(dispatched)).toMatchObject({
			ok: false,
			error: 'Dispatch capability disabled for project.',
		});
	});
});
