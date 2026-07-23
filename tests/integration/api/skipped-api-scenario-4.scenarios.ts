import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

import { packageRoot } from '../../support/api-harness.ts';

describe('market api',()=>{
it.skip('marks hosted project web deployments cancelled before dispatch after CAP-024 is lifted', async () => {
		const { app, store, token, project } = await createDeploymentReadyProject('runner-web-deploy-cancel');
		const queued = await json(await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({
				environment: 'staging',
				action: 'deploy_web',
				idempotencyKey: 'runner-web-deploy-cancel',
			}),
		}));
		const beforeCancel = await store.findProjectDeploymentById(queued.deployment.id);
		expect(beforeCancel).not.toBeNull();
		await store.updateProjectDeployment(beforeCancel!.id, {
			metadata: {
				...(beforeCancel!.metadata ?? {}),
				cancellation: {
					requested: true,
					requestedAt: '2026-01-01T00:00:00.000Z',
					actor: { id: 'user-1', type: 'user' },
				},
			},
		});

		await withHttpMarketApp(app, async (baseUrl) => {
			const client = new PlatformRunnerClient({
				marketUrl: baseUrl,
				marketId: 'local',
				runnerSecret: 'platform-runner-secret',
			});
			const result = await runOnceWithClient({
				runnerId: 'treeseed-ops-web-runner-03',
				environment: 'staging',
				dataDir: packageRoot,
			}, client, 'test', {
				deploymentStore: store,
				operationKey: 'project:web_deployment',
			});
			expect(result).toMatchObject({
				ok: false,
				claimed: true,
				operation: { status: 'cancelled' },
				error: { message: 'Deployment cancellation was requested.' },
			});
		});

		const deployment = await store.findProjectDeploymentById(queued.deployment.id);
		expect(deployment).not.toBeNull();
		expect(deployment).toMatchObject({
			status: 'cancelled',
			completedAt: expect.any(String),
			error: {
				code: 'deployment_cancelled',
				retrySafe: true,
				resumeSafe: false,
			},
		});
		const events = await store.listProjectDeploymentEvents(deployment!.id);
		expect(events.map((event: Record<string, unknown>) => event.kind)).toContain('deployment.cancelled');
		expect(events.map((event: Record<string, unknown>) => event.kind)).not.toContain('deployment.workflow.dispatching');
		const auditEvents = await store.listAuditEventsForTarget('project', project.id, 50);
		expect(auditEvents.map((event: Record<string, unknown>) => event.eventType)).toContain('project_deployment_cancelled');
	});
});
