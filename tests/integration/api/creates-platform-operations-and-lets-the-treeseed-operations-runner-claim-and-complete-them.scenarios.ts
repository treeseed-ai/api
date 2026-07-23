import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('creates platform operations and lets the Treeseed operations runner claim and complete them', async () => {
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
				namespace: 'repository',
				operation: 'write_content_record',
				idempotencyKey: 'platform-op-one',
				input: { collection: 'notes', slug: 'hello' },
			}),
		}));
		expect(created.ok).toBe(true);
		expect(created.operation).toMatchObject({
			namespace: 'repository',
			operation: 'write_content_record',
			status: 'queued',
			target: 'market_operations_runner',
		});

		const unauthenticatedClaim = await app.request('/v1/platform/runners/jobs/claim', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ runnerId: 'runner-1' }),
		});
		expect(unauthenticatedClaim.status).toBe(401);

		const nonPlatformRunnerToken = 'not-a-platform-runner-token';
		const providerClaim = await app.request('/v1/platform/runners/jobs/claim', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${nonPlatformRunnerToken}`,
			},
			body: JSON.stringify({ runnerId: 'provider-1' }),
		});
		expect(providerClaim.status).toBe(401);
		for (const path of [
			`/v1/platform/runners/jobs/${created.operation.id}/renew-lease`,
			`/v1/platform/runners/jobs/${created.operation.id}/checkpoint`,
			`/v1/platform/runners/jobs/${created.operation.id}/complete`,
			`/v1/platform/runners/jobs/${created.operation.id}/fail`,
		]) {
			const providerUpdate = await app.request(path, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${nonPlatformRunnerToken}`,
				},
				body: JSON.stringify({ runnerId: 'provider-1' }),
			});
			expect(providerUpdate.status).toBe(401);
		}

		const registered = await json(await app.request('/v1/platform/runners/register', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer platform-runner-secret',
			},
			body: JSON.stringify({
				runnerId: 'treeseed-ops-test-1',
				environment: 'staging',
				capabilities: ['repository:write_content_record'],
			}),
		}));
		expect(registered.runner).toMatchObject({
			id: 'treeseed-ops-test-1',
			environment: 'staging',
		});

		const claimed = await json(await app.request('/v1/platform/runners/jobs/claim', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer platform-runner-secret',
			},
			body: JSON.stringify({ runnerId: 'treeseed-ops-test-1', limit: 1 }),
		}));
		expect(claimed.operation.id).toBe(created.operation.id);
		expect(claimed.operation.status).toBe('leased');

		const staleCheckpoint = await app.request(`/v1/platform/runners/jobs/${created.operation.id}/checkpoint`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer platform-runner-secret',
			},
			body: JSON.stringify({
				runnerId: 'treeseed-ops-other',
				output: { changedPaths: [] },
			}),
		});
		expect(staleCheckpoint.status).toBe(409);

		const renewed = await json(await app.request(`/v1/platform/runners/jobs/${created.operation.id}/renew-lease`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer platform-runner-secret',
			},
			body: JSON.stringify({
				runnerId: 'treeseed-ops-test-1',
				leaseSeconds: 600,
			}),
		}));
		expect(renewed.operation.leaseExpiresAt).toEqual(expect.any(String));

		const checkpoint = await json(await app.request(`/v1/platform/runners/jobs/${created.operation.id}/checkpoint`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer platform-runner-secret',
			},
			body: JSON.stringify({
				runnerId: 'treeseed-ops-test-1',
				output: { changedPaths: [] },
				event: { kind: 'runner.progress', data: { phase: 'verified' } },
			}),
		}));
		expect(checkpoint.operation.status).toBe('running');

		const completed = await json(await app.request(`/v1/platform/runners/jobs/${created.operation.id}/complete`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer platform-runner-secret',
			},
			body: JSON.stringify({
				runnerId: 'treeseed-ops-test-1',
				output: { changedPaths: ['src/content/notes/hello.mdx'] },
			}),
		}));
		expect(completed.operation.status).toBe('succeeded');

		const events = await json(await app.request(`/v1/platform/operations/${created.operation.id}/events`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(events.events.map((event: Record<string, unknown>) => event.kind)).toEqual([
			'created',
			'claimed',
			'runner.lease_renewed',
			'runner.progress',
			'completed',
		]);
	});
});
