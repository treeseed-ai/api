import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

const { runTreeseedHostingAudit: runTreeseedHostingAuditMock } = getApiMocks();

describe('market api', () => {
it('queues launch failures for worker recovery instead of failing the request', async () => {
		runTreeseedHostingAuditMock.mockResolvedValueOnce({
			ok: false,
			environment: 'staging',
			requestedEnvironment: 'current',
			repairMode: false,
			repaired: false,
			target: { kind: 'persistent', scope: 'staging', label: 'staging' },
			hostKinds: ['repository', 'web'],
			checkedAt: '2026-01-01T00:00:00.000Z',
			checks: [],
			missingConfig: ['TREESEED_CLOUDFLARE_ACCOUNT_ID'],
			resources: {},
			warnings: [],
			blockers: [{ code: 'missing_config', message: 'Cloudflare account is not configured.' }],
			nextActions: ['Configure Cloudflare before launching.'],
		} as any);

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
				slug: 'failed-launch',
				name: 'Failed Launch',
				sourceKind: 'blank',
				hostingMode: 'managed',
			}),
		});

		expect(launched.status).toBe(202);
		const payload = await json(launched);
		expect(payload.ok).toBe(true);
		expect(payload.payload.launchJob.status).toBe('running');
		expect(payload.payload.project.project.metadata.launchPhase).toBe('queued');
		expect(await waitForCondition(async () => {
			const job = await store.findJobById(payload.operationId);
			return job?.status === 'failed';
		}, 8000)).toBe(true);

		const inbox = await json(await app.request(`/v1/teams/${team.id}/inbox`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(inbox.payload.some((entry: { kind: string; title: string }) => entry.kind === 'launch_failure' && entry.title.includes('Failed Launch'))).toBe(true);
	}, 60000);
});
