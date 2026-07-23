import { PlatformRunnerClient } from '@treeseed/sdk';
import { runOnceWithClient } from '../../../src/operations-runner/entrypoint.ts';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('queues linked repository initialization through the project API and operations runner', async () => {
		const fixture = createRunnerRepoFixture();
		try {
			const app = createTestApp({
				config: {
					platformRunnerSecret: 'platform-runner-secret',
				},
			});
			const token = await authorizeApp(app);
			const { project } = await createTeamAndProject(app, token, {
				id: 'linked-repository-project',
				slug: 'linked-repository-project',
				name: 'Linked Repository Project',
				metadata: {
					architecture: {
						topology: 'single_repository_site',
						rootPath: '.',
						sitePath: 'docs',
						contentPath: 'docs',
						contentRuntimeSource: 'r2_published_manifest',
						localContentMaterialization: 'none',
					},
				},
			});
			const queued = await json(await app.request(`/v1/projects/${project.id}/repositories/primary/initialize`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					repository: {
						provider: 'local',
						owner: 'treeseed',
						name: 'linked-repository-project',
						defaultBranch: 'staging',
						cloneUrl: fixture.repo,
						writeMode: 'workspace',
					},
					scaffoldFiles: [{
						path: 'docs/README.md',
						content: '# Linked Repository Project\n\nPrepared by a TreeSeed template.\n',
					}],
				}),
			}));
			expect(queued.ok).toBe(true);
			expect(queued.operation).toMatchObject({
				namespace: 'repository',
				operation: 'initialize_linked_repository',
				status: 'queued',
				input: {
					projectId: project.id,
					repositoryRole: 'primary',
					architecture: expect.objectContaining({
						topology: 'single_repository_site',
						sitePath: 'docs',
					}),
					scaffoldFiles: [{
						path: 'docs/README.md',
						content: '# Linked Repository Project\n\nPrepared by a TreeSeed template.\n',
					}],
					repository: expect.objectContaining({
						provider: 'local',
						name: 'linked-repository-project',
						cloneUrl: fixture.repo,
					}),
				},
			});
			await withHttpMarketApp(app, async (baseUrl) => {
				const client = new PlatformRunnerClient({
					marketUrl: baseUrl,
					marketId: 'local',
					runnerSecret: 'platform-runner-secret',
				});
				const result = await runOnceWithClient({
					runnerId: 'treeseed-ops-test-1',
					environment: 'local',
					dataDir: fixture.workspace,
				}, client, 'test', { operationId: queued.operation.id });
				expect(result).toMatchObject({ ok: true, claimed: true });
			});
			const completed = await json(await app.request(`/v1/platform/operations/${queued.operation.id}`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(completed.operation).toMatchObject({
				status: 'succeeded',
				changedPaths: ['docs/README.md'],
				output: {
					changedPaths: ['docs/README.md'],
					workspacePath: '<runner-workspace>',
					output: expect.objectContaining({
						kind: 'linked_repository_initialization',
						mode: 'template_scaffold',
						scaffoldedPaths: ['docs/README.md'],
					}),
				},
			});
			expect(JSON.stringify(completed.operation.output)).not.toContain(fixture.workspace);
			expect(JSON.stringify(completed.operation.output)).not.toMatch(/ghp_|TREESEED_GITHUB_TOKEN=/u);
			expect(existsSync(resolve(fixture.repo, 'docs/README.md'))).toBe(false);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
