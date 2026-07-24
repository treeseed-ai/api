import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('deletes projects and project-owned records through the project API', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const { team, project } = await createTeamAndProject(app, token, {
			slug: 'delete-me',
			name: 'Delete Me',
			description: 'Temporary project',
		});
		const headers = {
			'content-type': 'application/json',
			authorization: `Bearer ${token}`,
		};

		const blockers = await json(await app.request(`/v1/projects/${project.id}/deletion-blockers`, { headers }));
		expect(blockers.ok).toBe(true);
		expect(blockers.payload).toEqual([]);

		const rejected = await json(await app.request(`/v1/projects/${project.id}`, {
			method: 'DELETE',
			headers,
			body: JSON.stringify({ confirmation: 'DELETE wrong' }),
		}));
		expect(rejected.ok).toBe(false);
		expect(rejected.code).toBe('confirmation');

		const deleted = await json(await app.request(`/v1/projects/${project.id}`, {
			method: 'DELETE',
			headers,
			body: JSON.stringify({ confirmation: 'DELETE delete-me' }),
		}));
		expect(deleted.ok).toBe(true);
		expect(deleted.payload.projectId).toBe(project.id);
		expect(deleted.deploymentHref).toBe(`/app/projects/deployment/${deleted.payload.id}`);

		const after = await app.request(`/v1/projects/${project.id}`, {
			headers: { authorization: `Bearer ${token}` },
		});
		expect(after.status).toBe(200);
		expect(await waitForCondition(async () => {
			const job = await store.findJobById(deleted.job.id);
			const deployment = await store.findProjectDeploymentById(deleted.payload.id);
			return job?.status === 'completed' && deployment?.status === 'succeeded';
		})).toBe(true);
		const deployment = await store.findProjectDeploymentById(deleted.payload.id);
		expect(deployment?.action).toBe('delete_project');
		expect(deployment?.status).toBe('succeeded');
		expect((await store.getProject(project.id))?.metadata.deletion.status).toBe('succeeded');
		const projects = await json(await app.request(`/v1/projects?teamId=${team.id}`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(projects.payload.find((entry: { id: string }) => entry.id === project.id)).toBeUndefined();
		const profile = await json(await app.request(`/v1/teams/by-name/${team.name}/profile`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(profile.payload.activity.projects.find((entry: { id: string }) => entry.id === project.id)).toBeUndefined();

		const deletedTeam = await json(await app.request(`/v1/teams/${team.id}`, {
			method: 'DELETE',
			headers,
			body: JSON.stringify({ confirmation: `DELETE ${team.name}` }),
		}));
		expect(deletedTeam).toMatchObject({ ok: true });
	}, 30000);
});
