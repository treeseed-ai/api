import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('allows local acceptance admin token to manage workday runs in local mode', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		try {
			await store.ensureInitialized();
			await store.createTeam({ id: 'treeseed', slug: 'treeseed', name: 'TreeSeed' });
			const app = createTestApp({ db, store, config: { environment: 'local' } });
			const headers = {
				'content-type': 'application/json',
				authorization: 'Bearer tsk_local_treeseed_acceptance_admin',
			};
			const created = await app.request('/v1/teams/treeseed/workday-runs', {
				method: 'POST',
				headers,
				body: JSON.stringify({
					id: 'run-local-acceptance',
					capacityProviderId: 'provider-local',
					status: 'queued',
					parameters: { authMode: 'local_acceptance_admin', durationSeconds: 60 },
				}),
			});
			expect(created.status).toBe(201);
			const createdPayload = await json(created);
			expect(createdPayload.payload).toMatchObject({
				id: 'run-local-acceptance',
				requestedById: 'team-key:local-capacity-acceptance',
			});

			const event = await app.request('/v1/teams/treeseed/workday-runs/run-local-acceptance/events', {
				method: 'POST',
				headers,
				body: JSON.stringify({
					eventType: 'command.started',
					title: 'Started with local acceptance auth',
				}),
			});
			expect(event.status).toBe(201);

			const isolatedTeam = await app.request('/v1/teams', {
				method: 'POST',
				headers,
				body: JSON.stringify({ name: 'capacity-acceptance-isolated', displayName: 'Capacity acceptance isolated' }),
			});
			expect(isolatedTeam.status).toBe(200);
			const isolatedTeamPayload = await json(isolatedTeam);
			const isolatedTeamId = isolatedTeamPayload.payload.id;
			expect(await app.request(`/v1/teams/${isolatedTeamId}/capacity-registration-key/reveal`, { headers })).toMatchObject({ status: 200 });
			const deletedTeam = await app.request(`/v1/teams/${isolatedTeamId}`, {
				method: 'DELETE',
				headers,
				body: JSON.stringify({ confirmation: 'DELETE capacity-acceptance-isolated' }),
			});
			expect(deletedTeam.status).toBe(200);

			const listed = await json(await app.request('/v1/teams/treeseed/workday-runs', { headers }));
			expect(listed.payload.items.map((run: Record<string, unknown>) => run.id)).toContain('run-local-acceptance');
			expect(listed.payload.page).toMatchObject({ limit: 50, hasMore: false, nextCursor: null });
		} finally {
			db.close();
		}
	});
});
