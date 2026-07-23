import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('queues project web deployment operations with readiness, idempotency, events, retry, resume, and cancel semantics', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({
			db,
			store,
			config: {
				platformRunnerSecret: 'platform-runner-secret',
			},
		});
		const token = await authorizeApp(app);
		const { team, project } = await createTeamAndProject(app, token, {
			id: 'deploy-project',
			slug: 'deploy-project',
			name: 'Deploy Project',
		});

		const forbidden = await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ environment: 'staging', action: 'deploy_web', capacityProviderId: 'forbidden' }),
		});
		expect(forbidden.status).toBe(400);
		expect(await json(forbidden)).toMatchObject({ error: { code: 'validation_failed' } });

		const noRepo = await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ environment: 'staging', action: 'deploy_web' }),
		});
		expect(noRepo.status).toBe(409);
		expect(await json(noRepo)).toMatchObject({ error: { code: 'repository_not_ready' } });

		await store.upsertHubRepository(project.id, {
			teamId: team.id,
			role: 'software',
			provider: 'github',
			owner: 'treeseed-ai',
			name: 'deploy-project',
			url: 'https://github.com/treeseed-ai/deploy-project',
			defaultBranch: 'staging',
			status: 'ready',
		});
		await json(await app.request(`/v1/teams/${team.id}/web-hosts`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({
				name: 'Team Cloudflare',
				ownership: 'team_owned',
				encryptedPayload: encryptedHostEnvelope(),
			}),
		}));
		await store.upsertProjectEnvironment(project.id, {
			environment: 'staging',
			deploymentProfile: 'hosted_project',
			baseUrl: 'https://staging.deploy-project.example.com',
			pagesProjectName: 'deploy-project',
		});

		const productionWithoutConfirmation = await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ environment: 'prod', action: 'deploy_web' }),
		});
		expect(productionWithoutConfirmation.status).toBe(409);
		expect(await json(productionWithoutConfirmation)).toMatchObject({ error: { code: 'deployment_not_ready' } });

		const queued = await json(await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({
				environment: 'staging',
				action: 'deploy_web',
				source: 'market_ui',
				idempotencyKey: 'deploy-project-staging-one',
			}),
		}));
		expect(queued).toMatchObject({
			ok: true,
			pollUrl: expect.stringContaining('/v1/platform/operations/'),
			eventsUrl: expect.stringContaining(`/v1/projects/${project.id}/deployments/`),
			stateUrl: `/v1/projects/${project.id}/deployment-state`,
			deployment: {
				projectId: project.id,
				teamId: team.id,
				environment: 'staging',
				action: 'deploy_web',
				status: 'queued',
				idempotencyKey: 'deploy-project-staging-one',
			},
			operation: {
				namespace: 'project',
				operation: 'web_deployment',
				status: 'queued',
				target: 'market_operations_runner',
			},
		});
		expect(JSON.stringify(queued)).not.toContain('runnerToken');
		expect(JSON.stringify(queued)).not.toContain('capacityProviderId');

		const repeated = await json(await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({
				environment: 'staging',
				action: 'deploy_web',
				idempotencyKey: 'deploy-project-staging-one',
			}),
		}));
		expect(repeated.deployment.id).toBe(queued.deployment.id);
		expect(repeated.operation.id).toBe(queued.operation.id);

		const listed = await json(await app.request(`/v1/projects/${project.id}/deployments`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(listed.payload).toEqual([
			expect.objectContaining({ id: queued.deployment.id, platformOperationId: queued.operation.id }),
		]);

		const detail = await json(await app.request(`/v1/projects/${project.id}/deployments/${queued.deployment.id}`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(detail.payload).toMatchObject({ id: queued.deployment.id, platformOperationId: queued.operation.id });

		const events = await json(await app.request(`/v1/projects/${project.id}/deployments/${queued.deployment.id}/events`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(events.payload.map((event: any) => event.kind)).toEqual(expect.arrayContaining([
			'deployment.requested',
			'deployment.operation_queued',
			'created',
		]));

		const state = await json(await app.request(`/v1/projects/${project.id}/deployment-state`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(state).toMatchObject({
			ok: true,
			project: { id: project.id },
			latestDeployments: {
				staging: expect.objectContaining({ id: queued.deployment.id }),
			},
			readiness: {
				ready: false,
			},
		});
		expect(state.activeOperations).toHaveLength(1);

		const resumed = await app.request(`/v1/projects/${project.id}/deployments/${queued.deployment.id}/resume`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({}),
		});
		expect(resumed.status).toBe(409);
		expect(await json(resumed)).toMatchObject({ error: { code: 'operation_not_retryable' } });

		const cancelled = await json(await app.request(`/v1/projects/${project.id}/deployments/${queued.deployment.id}/cancel`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({}),
		}));
		expect(cancelled).toMatchObject({
			ok: true,
			cancellation: 'completed',
			deployment: {
				status: 'cancelled',
				completedAt: expect.any(String),
			},
		});

		const retried = await json(await app.request(`/v1/projects/${project.id}/deployments/${queued.deployment.id}/retry`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ idempotencyKey: 'deploy-project-staging-retry-one' }),
		}));
		expect(retried).toMatchObject({
			ok: true,
			originalDeployment: { id: queued.deployment.id },
			retryDeployment: {
				retryOfDeploymentId: queued.deployment.id,
				status: 'queued',
				platformOperationId: retried.operation.id,
			},
			operation: {
				namespace: 'project',
				operation: 'web_deployment',
			},
		});
	});
});
