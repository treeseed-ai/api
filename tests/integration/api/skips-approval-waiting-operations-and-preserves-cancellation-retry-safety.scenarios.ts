import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('skips approval-waiting operations and preserves cancellation/retry safety', async () => {
		const app = createTestApp({
			config: {
				platformRunnerSecret: 'platform-runner-secret',
			},
		});
		const token = await authorizeApp(app);
		const waiting = await json(await app.request('/v1/platform/operations', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				namespace: 'repository',
				operation: 'write_content_record',
				input: {
					approvalRequired: true,
					approvalId: 'approval-one',
					collection: 'notes',
				},
			}),
		}));
		expect(waiting.operation.status).toBe('waiting_for_approval');
		const skipped = await json(await app.request('/v1/platform/runners/jobs/claim', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer platform-runner-secret',
			},
			body: JSON.stringify({ runnerId: 'treeseed-ops-test-1', operationId: waiting.operation.id }),
		}));
		expect(skipped.operation).toBe(null);

		const created = await json(await app.request('/v1/platform/operations', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				namespace: 'market',
				operation: 'noop',
				input: {},
			}),
		}));
		await json(await app.request('/v1/platform/runners/jobs/claim', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer platform-runner-secret',
			},
			body: JSON.stringify({ runnerId: 'treeseed-ops-test-1', operationId: created.operation.id }),
		}));
		const cancelled = await json(await app.request(`/v1/platform/operations/${created.operation.id}/cancel`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(cancelled.operation.status).toBe('cancelled');
		const completeAfterCancel = await app.request(`/v1/platform/runners/jobs/${created.operation.id}/complete`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer platform-runner-secret',
			},
			body: JSON.stringify({ runnerId: 'treeseed-ops-test-1', output: { late: true } }),
		});
		expect(completeAfterCancel.status).toBe(409);
		const retried = await json(await app.request(`/v1/platform/operations/${created.operation.id}/retry`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ inputPatch: { retry: true } }),
		}));
		expect(retried.operation).toMatchObject({
			status: 'queued',
			assignedRunnerId: null,
			leaseExpiresAt: null,
			input: { retry: true },
		});
	});
});
