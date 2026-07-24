import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../support/api-harness.ts';

describe('market api', () => {
it('serves deep health and runner health summaries', async () => {
		const app = createTestApp();
		const deepHealth = await json(await app.request('/healthz/deep'));
		expect(deepHealth, JSON.stringify(deepHealth)).toMatchObject({
			ok: true,
			status: 'ok',
			checks: {
				database: true,
			},
		});

		const token = await authorizeApp(app);
		const { project } = await createTeamAndProject(app, token, {
			id: 'health-project',
			slug: 'health-project',
			name: 'Health Project',
		});
		const connection = await json(await app.request(`/v1/projects/${project.id}/connection`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				mode: 'hosted',
				projectApiBaseUrl: 'https://project.example.com',
				metadata: {
					projectApiKey: 'hosted-project-key',
				},
			}),
		}));
		const runnerToken = connection.payload.runnerToken as string;
		const runnerHealth = await json(await app.request(`/v1/projects/${project.id}/runner/health?environment=staging`, {
			headers: {
				authorization: `Bearer ${runnerToken}`,
			},
		}));
		expect(runnerHealth.ok).toBe(true);
		expect(runnerHealth.payload).not.toHaveProperty('pools');
		expect(Array.isArray(runnerHealth.payload.workdays)).toBe(true);
		for (const [method, pathname] of [
			['GET', `/v1/projects/${project.id}/agent-pools`],
			['POST', `/v1/projects/${project.id}/agent-pools`],
			['GET', `/v1/projects/${project.id}/agent-pools/retired/registrations`],
			['POST', `/v1/projects/${project.id}/agent-pools/retired/registrations`],
			['GET', `/v1/projects/${project.id}/agent-pools/retired/scale-decisions`],
			['POST', `/v1/projects/${project.id}/runner/agent-pools/retired/register`],
			['POST', `/v1/projects/${project.id}/runner/agent-pools/retired/scale-decisions`],
		] as const) {
			const response = await app.request(pathname, { method });
			expect(response.status, `${method} ${pathname}`).toBe(404);
		}
	});
});
