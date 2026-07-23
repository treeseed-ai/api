import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('queues core objective repository sync when project settings change the objective', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const { project } = await createTeamAndProject(app, token, {
			id: 'settings-core-objective-project',
			slug: 'settings-core-objective-project',
			name: 'Settings Core Objective Project',
			metadata: {
				coreObjective: '# Core Objective\n\nOriginal objective.',
			},
		});

		const response = await json(await app.request(`/v1/projects/${project.id}`, {
			method: 'PUT',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Settings Core Objective Project',
				slug: 'settings-core-objective-project',
				coreObjective: '# Core Objective\n\nUpdated objective for repository sync.',
			}),
		}));

		expect(response.ok).toBe(true);
		expect(response.payload.project.metadata.coreObjective).toContain('Updated objective');
		expect(response.coreObjectiveJob).toMatchObject({
			namespace: 'repository',
			operation: 'write_content_record',
			status: 'queued',
			input: {
				projectId: project.id,
				repositoryRole: 'content',
				collection: 'objectives',
				normalized: expect.objectContaining({
					slug: 'core',
					body: '# Core Objective\n\nUpdated objective for repository sync.',
				}),
				payload: expect.objectContaining({
					overwrite: true,
					preserveFrontmatter: true,
				}),
				repository: expect.objectContaining({
					writeMode: 'branch',
					push: true,
					branchName: expect.stringContaining('treeseed/core-objective-'),
				}),
				approvalRequired: true,
				approvalSatisfied: true,
				approvalId: expect.stringContaining(`project-settings:${project.id}:core-objective:`),
			},
		});
	});
});
