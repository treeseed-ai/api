import { PlatformRunnerClient } from '@treeseed/sdk';
import { runOnceWithClient } from '../../../src/operations-runner/entrypoint.ts';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('runs repository content jobs in the runner workspace instead of the API process', async () => {
		const fixture = createRunnerRepoFixture();
		try {
			const app = createTestApp({
				config: {
					platformRunnerSecret: 'platform-runner-secret',
				},
			});
			const token = await authorizeApp(app);
			const { project } = await createTeamAndProject(app, token, {
				id: 'runner-repository-project',
				slug: 'runner-repository-project',
				name: 'Runner Repository Project',
			});
			const queued = await json(await app.request(`/v1/projects/${project.id}/local-content/notes`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					title: 'Runner executed note',
					summary: 'Written by the Treeseed operations runner.',
					repository: {
						provider: 'local',
						owner: 'treeseed',
						name: 'runner-repository-project',
						defaultBranch: 'staging',
						cloneUrl: fixture.repo,
						writeMode: 'workspace',
					},
				}),
			}));
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
				}, client, 'test', { operationId: queued.job.id });
				expect(result).toMatchObject({ ok: true, claimed: true });
			});
			const completed = await json(await app.request(`/v1/platform/operations/${queued.job.id}`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(completed.operation).toMatchObject({
				status: 'succeeded',
				href: '/app/work/notes/runner-executed-note',
				changedPaths: ['src/content/notes/runner-executed-note.mdx'],
				branch: 'staging',
				commitSha: null,
				output: {
					href: '/app/work/notes/runner-executed-note',
					changedPaths: ['src/content/notes/runner-executed-note.mdx'],
					baseBranch: 'staging',
					branch: 'staging',
					commitSha: null,
					verification: null,
					pullRequest: null,
					workflowRun: null,
					workspacePath: '<runner-workspace>',
				},
			});
			expect(JSON.stringify(completed.operation.output)).not.toContain(fixture.workspace);
			expect(existsSync(resolve(fixture.repo, 'src/content/notes/runner-executed-note.mdx'))).toBe(false);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
