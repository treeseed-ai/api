import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('keeps managed project launch bootstrap owned by the API instead of the runner', async () => {
		await withEnv({
			TREESEED_CLOUDFLARE_API_TOKEN: 'managed-token',
			TREESEED_CLOUDFLARE_ACCOUNT_ID: 'managed-account',
		}, async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({
			db,
			store,
			config: {
				platformRunnerSecret: 'platform-runner-secret',
			},
		});
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);

		const launched = await json(await app.request(`/v1/teams/${team.id}/projects/launch`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({
				slug: 'runner-launch-project',
				name: 'Runner Launch Project',
				coreObjective: '# Core Objective\n\nVerify managed launch jobs are picked up.',
				sourceKind: 'template',
				sourceRef: 'research',
				hostingMode: 'managed',
			}),
		}));
		expect(launched.payload.launchJob.selectedTarget).toBe('api');
		expect(launched.payload.launchJob.status).toBe('running');
		expect(launched.payload.launchJob.input.credentialSessions).toBeUndefined();
		expect(await store.pullManagedLaunchJobs({ runnerId: 'treeseed-ops-launch-runner-01', limit: 5 })).toEqual([]);
		const job = await json(await app.request(`/v1/jobs/${launched.operationId}`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(job.payload.status).toBe('running');
		const state = await json(await app.request(`/v1/projects/${launched.projectId}/deployment-state`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(state.launch).toMatchObject({
			status: 'queued',
			active: true,
			currentPhase: 'credential_bootstrap',
		});
		});
	}, 60000);
});
