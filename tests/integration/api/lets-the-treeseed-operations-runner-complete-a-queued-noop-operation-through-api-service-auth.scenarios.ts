import { PlatformRunnerClient } from '@treeseed/sdk';
import { runOnceWithClient } from '../../../src/operations-runner/entrypoint.ts';
import { resolve } from 'node:path';
import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, rmSync, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

import { packageRoot } from '../../support/api-harness.ts';

describe('market api', () => {
it('lets the Treeseed operations runner complete a queued noop operation through API service auth', async () => {
		const app = createTestApp({
			config: {
				platformRunnerSecret: 'platform-runner-secret',
			},
		});
		const token = await authorizeApp(app);
		const created = await json(await app.request('/v1/platform/operations', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				namespace: 'market',
				operation: 'noop',
				input: { source: 'runner-integration-test' },
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
				dataDir: resolve(packageRoot, '.treeseed/test-treeseed-ops'),
			}, client, 'test');
			expect(result).toMatchObject({ ok: true, claimed: true });
		});
		const completed = await json(await app.request(`/v1/platform/operations/${created.operation.id}`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(completed.operation).toMatchObject({
			status: 'succeeded',
			terminal: true,
			output: {
				ok: true,
				message: 'Treeseed operations runner diagnostic completed.',
			},
		});
	});
});
