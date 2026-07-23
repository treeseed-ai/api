import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

import { packageRoot } from '../../support/api-harness.ts';

describe('market api',()=>{
it.skip('runs hosted monitor-only deployments without workflow dispatch after CAP-024 is lifted', async () => {
		const { app, store, token, project } = await createDeploymentReadyProject('runner-web-monitor-project');
		const queued = await json(await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({
				environment: 'staging',
				action: 'monitor',
				idempotencyKey: 'runner-web-monitor-success',
			}),
		}));

		await withHttpMarketApp(app, async (baseUrl) => {
			const client = new PlatformRunnerClient({
				marketUrl: baseUrl,
				marketId: 'local',
				runnerSecret: 'platform-runner-secret',
			});
			const result = await runOnceWithClient({
				runnerId: 'treeseed-ops-web-runner-monitor',
				environment: 'staging',
				dataDir: packageRoot,
			}, client, 'test', {
				deploymentStore: store,
				operationKey: 'project:web_deployment',
			});
			expect(result).toMatchObject({
				ok: true,
				claimed: true,
				output: {
					ok: true,
					deploymentId: queued.deployment.id,
					externalWorkflow: null,
					monitor: {
						status: 'healthy',
					},
				},
			});
		});

		const deployment = await store.findProjectDeploymentById(queued.deployment.id);
		expect(deployment).toMatchObject({
			status: 'succeeded',
			action: 'monitor',
			monitor: {
				status: 'healthy',
				checks: expect.arrayContaining([
					expect.objectContaining({ key: 'workflow_file', status: 'passed' }),
					expect.objectContaining({ key: 'http_response', status: 'passed' }),
				]),
			},
		});
		const events = await store.listProjectDeploymentEvents(queued.deployment.id);
		expect(events.map((event: Record<string, unknown>) => event.kind)).toEqual(expect.arrayContaining([
			'deployment.preflight.started',
			'deployment.preflight.completed',
			'deployment.monitor.started',
			'deployment.monitor.completed',
			'deployment.succeeded',
		]));
		expect(events.map((event: Record<string, unknown>) => event.kind)).not.toContain('deployment.workflow.dispatching');

		const state = await json(await app.request(`/v1/projects/${project.id}/deployment-state`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(state.latestMonitors.staging).toMatchObject({
			status: 'healthy',
			checks: expect.arrayContaining([
				expect.objectContaining({ key: 'http_response', status: 'passed' }),
			]),
		});
	});
});
