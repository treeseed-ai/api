import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

import { packageRoot } from '../../support/api-harness.ts';

describe('market api',()=>{
it.skip('records hosted project web deployment failures with GitHub inspect guidance after CAP-024 is lifted', async () => {
		const { app, store, token, project } = await createDeploymentReadyProject('runner-web-deploy-failure');
		const queued = await json(await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({
				environment: 'staging',
				action: 'deploy_web',
				idempotencyKey: 'runner-web-deploy-failure',
			}),
		}));

		await withHttpMarketApp(app, async (baseUrl) => {
			const client = new PlatformRunnerClient({
				marketUrl: baseUrl,
				marketId: 'local',
				runnerSecret: 'platform-runner-secret',
			});
			const result = await runOnceWithClient({
				runnerId: 'treeseed-ops-web-runner-02',
				environment: 'staging',
				dataDir: packageRoot,
			}, client, 'test', {
				deploymentStore: store,
				operationKey: 'project:web_deployment',
			});
			expect(result).toMatchObject({
				ok: false,
				claimed: true,
				error: { message: expect.stringContaining('deploy-web.yml') },
			});
		});

		const operation = await store.findPlatformOperationById(queued.operation.id);
		const deployment = await store.findProjectDeploymentById(queued.deployment.id);
		expect(operation).not.toBeNull();
		expect(deployment).not.toBeNull();
		expect(operation!.status).toBe('failed');
		expect(deployment).toMatchObject({
			status: 'failed',
			completedAt: expect.any(String),
			error: {
				provider: 'github',
				inspectCommand: 'gh run view 9001 --repo treeseed-ai/runner-web-deploy-failure --log-failed',
				failedJobName: 'deploy',
				retrySafe: true,
				resumeSafe: false,
				blockerCode: 'github_workflow_failed',
			},
		});
		const events = await store.listProjectDeploymentEvents(deployment!.id);
		expect(events.map((event: Record<string, unknown>) => event.kind)).toEqual(expect.arrayContaining([
			'deployment.workflow.completed',
			'deployment.failed',
		]));
		const auditEvents = await store.listAuditEventsForTarget('project', project.id, 50);
		expect(auditEvents.map((event: Record<string, unknown>) => event.eventType)).toContain('project_deployment_failed');
	});
});
