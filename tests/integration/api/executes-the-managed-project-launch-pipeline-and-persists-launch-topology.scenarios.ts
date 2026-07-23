import * as treeseedCore from '@treeseed/sdk';
import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

const { executeKnowledgeHubProviderLaunch: executeKnowledgeHubProviderLaunchMock } = getApiMocks();

describe('market api', () => {
it('executes the managed project launch pipeline and persists launch topology', async () => {
		await withEnv({
			TREESEED_CLOUDFLARE_API_TOKEN: 'managed-token',
			TREESEED_CLOUDFLARE_ACCOUNT_ID: 'managed-account',
		}, async () => {
		executeKnowledgeHubProviderLaunchMock.mockResolvedValue({
			workingRoot: '/tmp/hub-provider-launch-success',
			repository: {
				slug: 'treeseed-ai/launch-project',
				owner: 'treeseed-ai',
				name: 'launch-project',
				url: 'https://github.com/treeseed-ai/launch-project',
				defaultBranch: 'main',
				stagingBranch: 'staging',
				visibility: 'private',
			},
			workflows: {
				repository: 'treeseed-ai/launch-project',
				workflows: [{ workflowPath: '.github/workflows/verify.yml', changed: true, workingDirectory: '.' }],
				secrets: { existing: [], created: ['TREESEED_API_WEB_SERVICE_SECRET'] },
				variables: { existing: [], created: ['TREESEED_API_BASE_URL'] },
			},
			cloudflare: {
				staging: {
					accountId: 'cf-account-1',
					workerName: 'launch-project-staging',
					siteUrl: 'https://launch-project-staging.pages.dev',
					pages: { projectName: 'launch-project-staging', url: 'https://launch-project-staging.pages.dev' },
					content: { bucketName: 'launch-project-staging-content' },
					siteDataDb: { databaseName: 'launch-project-staging-db' },
					queue: { name: 'launch-project-staging-queue' },
				},
				prod: {
					accountId: 'cf-account-1',
					workerName: 'launch-project',
					siteUrl: 'https://launch-project.pages.dev',
					pages: { projectName: 'launch-project', url: 'https://launch-project.pages.dev' },
					content: { bucketName: 'launch-project-content' },
					siteDataDb: { databaseName: 'launch-project-db' },
					queue: { name: 'launch-project-queue' },
				},
				verification: { ok: true },
			},
			railway: {
				services: [{
					key: 'api',
					scope: 'prod',
					projectName: 'launch-project',
					serviceName: 'launch-project-api',
					publicBaseUrl: 'https://launch-project-api.up.railway.app',
				}],
				deployments: [],
				schedules: [],
				verification: { ok: true },
			},
			projectApiBaseUrl: 'https://launch-project-api.up.railway.app',
			projectSiteUrl: 'https://launch-project.pages.dev',
			projectMetadata: {
				objectiveCount: 1,
				questionCount: 1,
				noteCount: 1,
				proposalCount: 1,
				decisionCount: 1,
				workstreams: [{
					id: 'launch-project:initial-launch',
					title: 'Initial launch',
				}],
			},
			defaultWorkstream: {
				id: 'launch-project:initial-launch',
				title: 'Initial launch',
				state: 'saved_remote',
			},
			phases: [
				{ phase: 'repo_provision', status: 'completed', detail: 'Created repository.', timestamp: '2026-04-16T00:00:00.000Z' },
				{ phase: 'content_bootstrap', status: 'completed', detail: 'Scaffolded starter template.', timestamp: '2026-04-16T00:00:01.000Z' },
				{ phase: 'host_binding_config', status: 'completed', detail: 'Applied host binding config.', timestamp: '2026-04-16T00:00:02.000Z' },
				{ phase: 'workflow_bootstrap', status: 'completed', detail: 'Installed workflows.', timestamp: '2026-04-16T00:00:03.000Z' },
				{ phase: 'hosting_registration', status: 'completed', detail: 'Provisioned Cloudflare.', timestamp: '2026-04-16T00:00:04.000Z' },
				{ phase: 'runtime_connection', status: 'completed', detail: 'Connected Railway runtime.', timestamp: '2026-04-16T00:00:05.000Z' },
			],
			templatePackage: {
				outputRoot: '/tmp/hub-provider-launch-success/template',
				payloadRoot: '/tmp/hub-provider-launch-success/template/payload',
				manifestPath: '/tmp/hub-provider-launch-success/template/manifest.json',
				files: ['package.json'],
				manifest: {
					schemaVersion: 1,
					kind: 'template',
					id: 'launch-project-template',
					title: 'Launch Project template',
					summary: 'Template package',
					version: '0.1.0',
					generatedAt: '2026-04-16T00:00:05.000Z',
					projectSlug: 'launch-project',
					sourceProjectRoot: '/tmp/hub-provider-launch-success',
					payloadRoot: 'payload',
					files: ['package.json'],
					compatibility: { minCliVersion: '0.1.0', minCoreVersion: '0.1.0', minSdkVersion: '0.1.0' },
					sourceSelection: { includedPaths: ['package.json'] },
					market: { publisherId: 'team-one', publisherName: 'Team One', publishMetadata: {} },
				},
			},
			knowledgePackPackage: {
				outputRoot: '/tmp/hub-provider-launch-success/knowledge-pack',
				payloadRoot: '/tmp/hub-provider-launch-success/knowledge-pack/payload',
				manifestPath: '/tmp/hub-provider-launch-success/knowledge-pack/manifest.json',
				files: ['src/content/objectives/launch.mdx'],
				manifest: {
					schemaVersion: 1,
					kind: 'knowledge_pack',
					id: 'launch-project-pack',
					title: 'Launch Project knowledge pack',
					summary: 'Knowledge pack',
					version: '0.1.0',
					generatedAt: '2026-04-16T00:00:05.000Z',
					projectSlug: 'launch-project',
					sourceProjectRoot: '/tmp/hub-provider-launch-success',
					payloadRoot: 'payload',
					files: ['src/content/objectives/launch.mdx'],
					compatibility: { minCliVersion: '0.1.0', minCoreVersion: '0.1.0', minSdkVersion: '0.1.0' },
					sourceSelection: { includedPaths: ['src/content/objectives'] },
					market: { publisherId: 'team-one', publisherName: 'Team One', publishMetadata: {} },
				},
			},
		} as unknown as Awaited<ReturnType<typeof treeseedCore.executeKnowledgeHubProviderLaunch>>);

		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);

		const launched = await app.request(`/v1/teams/${team.id}/projects/launch`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				slug: 'launch-project',
				name: 'Launch Project',
				coreObjective: '# Core Objective\n\nKeep launch work aligned around reliable project deployment.',
				sourceKind: 'template',
				sourceRef: 'research',
				hostingMode: 'managed',
			}),
		});

		expect(launched.status).toBe(202);
		const payload = await json(launched);
		expect(payload.ok).toBe(true);
		expect(payload.projectId).toBe(payload.payload.project.project.id);
		expect(payload.launchId).toBe(payload.payload.launch.id);
		expect(payload.operationId).toBe(payload.payload.launchJob.id);
		expect(payload.payload.deployments.some((deployment: { id: string }) => deployment.id === payload.deploymentId)).toBe(true);
		expect(payload.deploymentHref).toBe(`/app/projects/deployment/${payload.deploymentId}`);
		expect(payload.payload.project.project.slug).toBe('launch-project');
		expect(payload.payload.project.project.description).toBe('Core Objective Keep launch work aligned around reliable project deployment.');
		expect(payload.payload.project.project.metadata.coreObjective).toBe('# Core Objective\n\nKeep launch work aligned around reliable project deployment.');
		expect(payload.payload.project.project.metadata.templateLineage).toEqual([
			expect.objectContaining({
				kind: 'template',
				ref: 'research',
				source: 'project_launch',
			}),
		]);
		expect(payload.payload.project.latestLaunch.state).toBe('running');
		expect(payload.payload.launchJob.status).toBe('running');
		expect(payload.payload.launchJob.selectedTarget).toBe('api');
		expect(payload.payload.launchJob.input.credentialSessions).toBeUndefined();
		expect(payload.payload.deployments).toEqual(expect.arrayContaining([
			expect.objectContaining({ environment: 'staging', action: 'launch_project', status: 'running', platformOperationId: payload.operationId }),
			expect.objectContaining({ environment: 'prod', action: 'launch_project', status: 'running', platformOperationId: payload.operationId }),
		]));
		expect(payload.payload.launchJob.input.launchIntent.hub.coreObjective).toBe('# Core Objective\n\nKeep launch work aligned around reliable project deployment.');
		expect(payload.payload.launchJob.input.launchIntent.execution.providerLaunchInput.coreObjective).toBe('# Core Objective\n\nKeep launch work aligned around reliable project deployment.');
		expect(payload.payload.launchJob.input.launchIntent.execution.providerLaunchInput.hostBindingPlans.configWrites).toEqual(expect.arrayContaining([
			expect.objectContaining({
				target: 'treeseed.site.yaml',
				path: 'hosting.hostBindings.sourceRepository.provider',
				requirementKey: 'sourceRepository',
			}),
		]));
		expect(payload.payload.launchJob.input.launchIntent.execution.providerLaunchInput.hostBindings.publicWeb.provider).toBe('cloudflare');
		expect(executeKnowledgeHubProviderLaunchMock).not.toHaveBeenCalled();

		const deploymentDetail = await json(await app.request(`/v1/project-deployments/${payload.deploymentId}`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(deploymentDetail.payload.deployment).toMatchObject({
			id: payload.deploymentId,
			projectId: payload.projectId,
			status: 'running',
			platformOperationId: payload.operationId,
		});
		expect(deploymentDetail.payload.events.some((event: { kind: string }) => event.kind === 'launch.bootstrap_started')).toBe(true);

		const details = await json(await app.request(`/v1/projects/${payload.payload.project.project.id}`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(details.payload.repositories).toEqual(expect.arrayContaining([
			expect.objectContaining({ role: 'software', name: 'launch-project-site', status: 'queued' }),
			expect.objectContaining({ role: 'content', name: 'launch-project-content', status: 'queued' }),
		]));
		expect(details.payload.project.metadata.hostBindings).toMatchObject({
			sourceRepository: expect.objectContaining({
				requirementKey: 'sourceRepository',
				type: 'repository',
				provider: 'github',
			}),
			publicWeb: expect.objectContaining({
				requirementKey: 'publicWeb',
				type: 'web',
				provider: 'cloudflare',
			}),
		});
		expect(details.payload.hosting.metadata.hostBindings.publicWeb.provider).toBe('cloudflare');
		expect(payload.payload.launchJob.input.hostBindings.publicWeb.provider).toBe('cloudflare');
		expect(payload.payload.launchJob.input.launchIntent.hosting.hostBindings.publicWeb.provider).toBe('cloudflare');
		expect(details.payload.contentSource.productionSource).toBe('r2_published_artifacts');
		expect(details.payload.latestLaunch.state).toBe('running');
		const deploymentState = await json(await app.request(`/v1/projects/${payload.projectId}/deployment-state`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(deploymentState.launch).toMatchObject({
			id: payload.launchId,
			jobId: payload.operationId,
			status: 'queued',
			active: true,
			deployHref: `/app/projects/deployment/${payload.deploymentId}`,
		});
		await store.retryJob(payload.operationId, { status: 'failed', eventType: 'failed' });
		await store.updateHubLaunch(payload.launchId, {
			state: 'failed',
			currentPhase: 'workflow_installing',
			error: {
				summary: 'Workflow installation failed.',
				inspectCommand: 'gh run view 123 --repo owner/repo --log-failed',
			},
		});
		await store.appendHubLaunchEvent(payload.launchId, {
			phase: 'workflow_installing',
			status: 'failed',
			title: 'Workflow installation failed',
			summary: 'Workflow installation failed.',
		});
		const failedState = await json(await app.request(`/v1/projects/${payload.projectId}/deployment-state`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(failedState.launch).toMatchObject({
			status: 'failed',
			active: false,
			error: {
				summary: 'Workflow installation failed.',
				inspectCommand: 'gh run view 123 --repo owner/repo --log-failed',
			},
		});
		expect(failedState.launch.actions.map((action: { action: string }) => action.action)).toEqual(['retry_launch', 'resume_launch']);
		expect(failedState.nextAction).toMatchObject({ code: 'launch_recovery', action: 'retry_launch' });
		const resumed = await app.request(`/v1/jobs/${payload.operationId}/resume`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
			},
		});
		expect(resumed.status).toBe(202);
		const resumedState = await json(await app.request(`/v1/projects/${payload.projectId}/deployment-state`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(resumedState.launch.status).not.toBe('failed');
		expect(['credential_bootstrap', 'hosting_readiness_audit', 'provider_bootstrap', 'launch_completed']).toContain(resumedState.launch.currentPhase);
		if (resumedState.launch.status === 'completed') {
			expect(resumedState.launch.active).toBe(false);
		} else {
			expect(resumedState.launch.active).toBe(true);
		}

		expect(await waitForCondition(async () => {
			const inbox = await json(await app.request(`/v1/teams/${team.id}/inbox`, {
				headers: {
					authorization: `Bearer ${token}`,
				},
			}));
			return inbox.payload.some((entry: { kind: string }) => entry.kind === 'launch_failure');
		}, 8000)).toBe(true);
		});
	}, 30000);
});
