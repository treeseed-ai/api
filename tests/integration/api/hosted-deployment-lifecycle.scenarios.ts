import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';
import { packageRoot } from '../../support/api-harness.ts';

describe('hosted deployment lifecycle after CAP-024 is lifted', () => {
	it.skip('runs hosted project web deployments through the Treeseed operations runner after CAP-024 is lifted', async () => {
			const { app, store, token, project } = await createDeploymentReadyProject('runner-web-deploy-project');
			await store.upsertProjectArchitecture(project.id, {
				topology: 'single_repository_site',
				rootPath: '.',
				sitePath: '.',
				contentPath: 'src/content',
				contentRuntimeSource: 'r2_published_manifest',
				localContentMaterialization: 'existing_path',
				contentPublishTarget: {
					kind: 'cloudflare_r2',
					bucket: 'treeseed-content',
					manifestPath: 'teams/runner-web-deploy-project/published/common.json',
				},
			});
			const unrelated = await store.createPlatformOperation({
				namespace: 'market',
				operation: 'noop',
				target: 'market_operations_runner',
				input: {},
				requestedByType: 'user',
				requestedById: 'user-1',
			});
			const queued = await json(await app.request(`/v1/projects/${project.id}/deployments/web`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
				body: JSON.stringify({
					environment: 'staging',
					action: 'deploy_web',
					idempotencyKey: 'runner-web-deploy-success',
				}),
			}));
			expect(JSON.stringify(queued)).not.toMatch(/railway/i);
	
			await withHttpMarketApp(app, async (baseUrl) => {
				const client = new PlatformRunnerClient({
					marketUrl: baseUrl,
					marketId: 'local',
					runnerSecret: 'platform-runner-secret',
				});
				const result = await runOnceWithClient({
					runnerId: 'treeseed-ops-web-runner-01',
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
						externalWorkflow: {
							provider: 'github',
							runId: 9001,
							runUrl: expect.stringContaining('/actions/runs/9001'),
						},
					},
				});
			});
	
			expect(unrelated).not.toBeNull();
			const untouched = await store.findPlatformOperationById(unrelated!.id);
			expect(untouched).not.toBeNull();
			expect(untouched!.status).toBe('queued');
			const completedOperation = await store.findPlatformOperationById(queued.operation.id);
			expect(completedOperation).not.toBeNull();
			expect(completedOperation!.status).toBe('succeeded');
			expect(JSON.stringify(completedOperation)).not.toMatch(/railway/i);
			const deployment = await store.findProjectDeploymentById(queued.deployment.id);
			expect(deployment).not.toBeNull();
			expect(deployment).toMatchObject({
				status: 'succeeded',
				completedAt: expect.any(String),
				externalWorkflow: {
					runId: 9001,
					mock: true,
					conclusion: 'success',
				},
				target: {
					baseUrl: 'https://staging.runner-web-deploy-project.example.com',
				},
				monitor: {
					status: 'healthy',
					contentRuntime: {
						contentRuntimeSource: 'r2_published_manifest',
						effectiveContentSource: 'r2_published_manifest',
						manifestKey: 'teams/runner-web-deploy-project/published/common.json',
					},
					checks: expect.arrayContaining([
						expect.objectContaining({ key: 'latest_workflow', status: 'passed' }),
						expect.objectContaining({ key: 'workflow_file', status: 'passed' }),
						expect.objectContaining({ key: 'http_response', status: 'passed' }),
						expect.objectContaining({ key: 'content_runtime', status: 'passed', source: 'r2' }),
					]),
				},
				summary: 'deploy_web for staging succeeded.',
			});
			const events = await store.listProjectDeploymentEvents(deployment!.id);
			expect(events.map((event: Record<string, unknown>) => event.kind)).toEqual(expect.arrayContaining([
				'deployment.preflight.started',
				'deployment.preflight.completed',
				'deployment.workflow.dispatching',
				'deployment.workflow.dispatched',
				'deployment.workflow.running',
				'deployment.workflow.completed',
				'deployment.monitor.started',
				'deployment.monitor.completed',
				'deployment.succeeded',
			]));
			const auditEvents = await store.listAuditEventsForTarget('project', project.id, 50);
			expect(auditEvents.map((event: Record<string, unknown>) => event.eventType)).toEqual(expect.arrayContaining([
				'project_monitor_completed',
				'project_deployment_succeeded',
			]));
			const environments = await store.listProjectEnvironments(project.id);
			expect(environments.find((entry: Record<string, unknown>) => entry.environment === 'staging')).toMatchObject({
				baseUrl: 'https://staging.runner-web-deploy-project.example.com',
				metadata: {
						lastDeploymentId: deployment!.id,
						lastOperationId: queued.operation.id,
					},
				});
			expect(await store.all(`SELECT * FROM capacity_providers`)).toHaveLength(0);
			expect(JSON.stringify(completedOperation!)).not.toContain('capacityProviderId');
		}, 20_000);

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
