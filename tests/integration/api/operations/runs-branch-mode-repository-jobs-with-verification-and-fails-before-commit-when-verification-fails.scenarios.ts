import { PlatformRunnerClient } from '@treeseed/sdk';
import { runOnceWithClient } from '../../../../src/operations-runner/entrypoint.ts';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../support/api-harness.ts';

describe('market api', () => {
it('runs branch-mode repository jobs with verification and fails before commit when verification fails', async () => {
		const fixture = createRunnerRepoFixture();
		try {
			const app = createTestApp({
				config: {
					platformRunnerSecret: 'platform-runner-secret',
				},
			});
			const token = await authorizeApp(app);
			const branchJob = await json(await app.request('/v1/platform/operations', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					namespace: 'repository',
					operation: 'write_content_record',
					input: {
						projectId: 'runner-branch-project',
						collection: 'notes',
						payload: { title: 'Branch verified note' },
						repository: {
							provider: 'local',
							owner: 'treeseed',
							name: 'runner-branch-project',
							defaultBranch: 'staging',
							cloneUrl: fixture.repo,
							writeMode: 'branch',
							branchName: 'treeseed/branch-verified',
							verificationCommands: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
						},
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
					runnerId: 'treeseed-ops-runner-01',
					environment: 'staging',
					dataDir: fixture.workspace,
				}, client, 'test', { operationId: branchJob.operation.id });
				expect(result).toMatchObject({ ok: true, claimed: true });
			});
			const completed = await json(await app.request(`/v1/platform/operations/${branchJob.operation.id}`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(completed.operation).toMatchObject({
				status: 'succeeded',
				branch: 'treeseed/branch-verified',
				output: {
					branch: 'treeseed/branch-verified',
					operationBranch: 'treeseed/branch-verified',
					verification: { status: 'passed' },
					pullRequest: null,
					workflowRun: null,
				},
			});
			expect(completed.operation.commitSha).toMatch(/^[a-f0-9]{40}$/u);
			expect(git(fixture.repo, ['branch', '--list', 'treeseed/branch-verified'])).toBe('');

			const failingJob = await json(await app.request('/v1/platform/operations', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					namespace: 'repository',
					operation: 'write_content_record',
					input: {
						projectId: 'runner-branch-project',
						collection: 'notes',
						payload: { title: 'Verification failing note' },
						repository: {
							provider: 'local',
							owner: 'treeseed',
							name: 'runner-failing-project',
							defaultBranch: 'staging',
							cloneUrl: fixture.repo,
							writeMode: 'branch',
							branchName: 'treeseed/failing-branch',
							verificationCommands: [{ command: process.execPath, args: ['-e', 'process.exit(9)'] }],
						},
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
					runnerId: 'treeseed-ops-runner-02',
					environment: 'staging',
					dataDir: resolve(fixture.root, 'workspace-2'),
				}, client, 'test', { operationId: failingJob.operation.id });
				expect(result).toMatchObject({ ok: false, claimed: true });
			});
			const failed = await json(await app.request(`/v1/platform/operations/${failingJob.operation.id}`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(failed.operation).toMatchObject({
				status: 'failed',
				error: { message: expect.stringContaining('Repository verification failed') },
			});
			const events = await json(await app.request(`/v1/platform/operations/${failingJob.operation.id}/events`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(events.events.map((event: Record<string, unknown>) => event.kind)).toContain('repository.verification_failed');
			expect(git(fixture.repo, ['branch', '--list', 'treeseed/failing-branch'])).toBe('');
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
