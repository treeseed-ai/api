import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('keeps project-runner approval reporting while every retired workday compatibility route returns 404', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const { team, project } = await createTeamAndProject(app, token, {
			id: 'hosted-runtime-project',
			slug: 'hosted-runtime-project',
			name: 'Hosted Runtime Project',
		});
		const connection = await json(await app.request(`/v1/projects/${project.id}/connection`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				mode: 'hosted',
				executionOwner: 'project_runner',
				rotateRunnerToken: true,
			}),
		}));
		const runnerToken = connection.payload.runnerToken as string;

		expect((await app.request(`/v1/projects/${project.id}/runner/tasks`, {
			headers: { authorization: `Bearer ${runnerToken}` },
		})).status).toBe(404);
		expect((await app.request(`/v1/projects/${project.id}/tasks`, {
			headers: { authorization: `Bearer ${token}` },
		})).status).toBe(404);
		for (const route of [
			'manager-leases',
			'worker-runners',
			'repository-claims',
			'runner-scale-decisions',
		]) {
			expect((await app.request(`/v1/projects/${project.id}/runner/${route}`, {
				headers: { authorization: `Bearer ${runnerToken}` },
			})).status).toBe(404);
		}

		const retiredRoutes: Array<[string, string, string]> = [
			['POST', `/v1/projects/${project.id}/runner/workdays/start`, runnerToken],
			['GET', `/v1/projects/${project.id}/runner/workdays/runtime`, runnerToken],
			['POST', `/v1/projects/${project.id}/runner/workdays/retired/close`, runnerToken],
			['GET', `/v1/projects/${project.id}/workdays`, token],
			['GET', `/v1/projects/${project.id}/workdays/retired`, token],
			['POST', `/v1/projects/${project.id}/workdays/start`, token],
			['POST', `/v1/projects/${project.id}/workdays/retired/close`, token],
			['GET', `/v1/projects/${project.id}/work-policy`, token],
			['PUT', `/v1/projects/${project.id}/workday-policy`, token],
			['GET', `/v1/projects/${project.id}/workday-status`, token],
			['POST', `/v1/projects/${project.id}/workday-requests`, token],
			['GET', `/v1/projects/${project.id}/priority-overrides`, token],
			['GET', `/v1/projects/${project.id}/priority-snapshots`, token],
			['POST', `/v1/projects/${project.id}/runner/priority-snapshots`, runnerToken],
			['POST', `/v1/projects/${project.id}/runner/task-credits`, runnerToken],
			['GET', `/v1/projects/${project.id}/workdays/retired/task-credits`, token],
			['POST', `/v1/projects/${project.id}/agents/architect/run`, token],
			['POST', `/v1/projects/${project.id}/agents/architect/pause`, token],
			['POST', `/v1/projects/${project.id}/agents/architect/resume`, token],
		];
		for (const [method, path, routeToken] of retiredRoutes) {
			expect((await app.request(path, {
				method,
				headers: { 'content-type': 'application/json', authorization: `Bearer ${routeToken}` },
				body: method === 'GET' ? undefined : '{}',
			})).status, `${method} ${path}`).toBe(404);
		}

		const approval = await json(await app.request(`/v1/projects/${project.id}/runner/approval-requests`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${runnerToken}`,
			},
			body: JSON.stringify({
				id: 'hosted-approval-1',
				workDayId: 'hosted-workday-1',
				kind: 'promote_knowledge_draft',
				title: 'Promote hosted docs',
				summary: 'Hosted docs promotion needs approval.',
				metadata: { runtimeMode: 'hosted' },
			}),
		}));
		expect(approval.payload).toMatchObject({
			id: 'hosted-approval-1',
			projectId: project.id,
			teamId: team.id,
			state: 'pending',
		});
	});
});
