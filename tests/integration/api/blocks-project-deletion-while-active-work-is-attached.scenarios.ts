import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('blocks project deletion while active work is attached', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const { project } = await createTeamAndProject(app, token, {
			slug: 'busy-project',
			name: 'Busy Project',
		});
		const headers = {
			'content-type': 'application/json',
			authorization: `Bearer ${token}`,
		};

		const createdWorkday = await json(await app.request('/v1/workdays', {
			method: 'POST',
			headers: { ...headers, 'idempotency-key': 'busy-project-workday-create' },
			body: JSON.stringify({
				id: 'busy-project-workday',
				projectId: project.id,
				status: 'active',
				environment: 'local',
				metadata: { source: 'project_deletion_regression' },
			}),
		}));
		expect(createdWorkday.ok).toBe(true);
		const blockers = await json(await app.request(`/v1/projects/${project.id}/deletion-blockers`, { headers }));
		expect(blockers.payload.some((entry: { code: string }) => entry.code === 'active_workday')).toBe(true);

		const deleted = await json(await app.request(`/v1/projects/${project.id}`, {
			method: 'DELETE',
			headers,
			body: JSON.stringify({ confirmation: 'DELETE busy-project' }),
		}));
		expect(deleted.ok).toBe(false);
		expect(deleted.code).toBe('blocked');
	});
});
