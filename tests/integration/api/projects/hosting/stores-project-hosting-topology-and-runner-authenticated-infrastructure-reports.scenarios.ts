import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('stores project hosting topology and runner-authenticated infrastructure reports', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const { team, project } = await createTeamAndProject(app, token, {
			id: 'topology-project',
			slug: 'topology-project',
			name: 'Topology Project',
		});

		const hosting = await json(await app.request(`/v1/projects/${project.id}/hosting`, {
			method: 'PUT',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				kind: 'hosted_project',
				registration: 'optional',
				marketBaseUrl: 'https://market.example.com',
				sourceRepoOwner: 'treeseed-ai',
				sourceRepoName: 'topology-project',
				sourceRepoUrl: 'https://github.com/treeseed-ai/topology-project',
				sourceRepoWorkflowPath: '.github/workflows/deploy-web.yml',
			}),
		}));
		expect(hosting.payload).toMatchObject({
			projectId: project.id,
			kind: 'hosted_project',
			registration: 'optional',
		});
		const invalidHosting = await json(await app.request(`/v1/projects/${project.id}/hosting`, {
			method: 'PUT',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				kind: 'mystery_host',
			}),
		}));
		expect(invalidHosting.ok).toBe(false);
		expect(invalidHosting.error).toBe('Invalid hosting kind.');
		const advancedConnection = await json(await app.request(`/v1/projects/${project.id}/connection`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				mode: 'hybrid',
				executionOwner: 'project_runner',
				projectApiBaseUrl: '',
			}),
		}));
		expect(advancedConnection.payload.connection).toMatchObject({
			projectId: project.id,
			mode: 'hybrid',
			projectApiBaseUrl: null,
			executionOwner: 'project_runner',
		});
		const invalidConnection = await json(await app.request(`/v1/projects/${project.id}/connection`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				mode: 'chaos',
			}),
		}));
		expect(invalidConnection.ok).toBe(false);
		expect(invalidConnection.error).toBe('Invalid connection mode.');

		const environment = await json(await app.request(`/v1/projects/${project.id}/environments/staging`, {
			method: 'PUT',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				deploymentProfile: 'hosted_project',
				baseUrl: 'https://staging.example.com',
				cloudflareAccountId: 'cf-account-1',
				pagesProjectName: 'topology-project',
				workerName: 'topology-project-staging-worker',
				r2BucketName: 'topology-project-staging-content',
				d1DatabaseName: 'topology-project-staging-db',
				queueName: 'topology-project-staging-queue',
				railwayProjectName: 'topology-project',
			}),
		}));
		expect(environment.payload).toMatchObject({
			projectId: project.id,
			environment: 'staging',
			pagesProjectName: 'topology-project',
		});

		const resource = await json(await app.request(`/v1/projects/${project.id}/resources`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				environment: 'staging',
				provider: 'cloudflare',
				resourceKind: 'r2',
				logicalName: 'content',
				locator: 'teams/team-one/published/common.json',
			}),
		}));
		expect(resource.payload).toMatchObject({
			projectId: project.id,
			provider: 'cloudflare',
			resourceKind: 'r2',
			logicalName: 'content',
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

		const runnerEnvironment = await json(await app.request(`/v1/projects/${project.id}/runner/environments/prod`, {
			method: 'PUT',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${runnerToken}`,
			},
			body: JSON.stringify({
				deploymentProfile: 'hosted_project',
				baseUrl: 'https://prod.example.com',
				pagesProjectName: 'topology-project',
				workerName: 'topology-project-prod-worker',
				r2BucketName: 'topology-project-prod-content',
				railwayProjectName: 'topology-project',
			}),
		}));
		expect(runnerEnvironment.payload).toMatchObject({
			environment: 'prod',
			pagesProjectName: 'topology-project',
		});

		const runnerResource = await json(await app.request(`/v1/projects/${project.id}/runner/resources`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${runnerToken}`,
			},
			body: JSON.stringify({
				environment: 'prod',
				provider: 'railway',
				resourceKind: 'service',
				logicalName: 'manager',
				locator: 'railway://topology-project-prod/manager',
			}),
		}));
		expect(runnerResource.payload).toMatchObject({
			environment: 'prod',
			provider: 'railway',
			resourceKind: 'service',
			logicalName: 'manager',
		});

		const runnerDeployment = await json(await app.request(`/v1/projects/${project.id}/runner/deployments`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${runnerToken}`,
			},
			body: JSON.stringify({
				environment: 'prod',
				deploymentKind: 'mixed',
				status: 'success',
				sourceRef: 'main',
				commitSha: 'def456',
			}),
		}));
		expect(runnerDeployment.payload).toMatchObject({
			environment: 'prod',
			deploymentKind: 'mixed',
			status: 'succeeded',
		});

		const details = await json(await app.request(`/v1/projects/${project.id}`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(details.payload.hosting).toMatchObject({
			kind: 'hosted_project',
		});
		expect(details.payload.environments).toHaveLength(2);
		expect(details.payload.resources).toHaveLength(2);
		expect(details.payload.deployments).toHaveLength(1);
		expect(details.payload).not.toHaveProperty('agentPools');
	});
});
