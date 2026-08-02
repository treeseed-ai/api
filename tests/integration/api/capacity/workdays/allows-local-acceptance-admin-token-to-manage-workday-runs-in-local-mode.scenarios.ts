import { createTestApp,createTestPostgresDatabase,createTestStore,describe,expect,it,json } from '../../../../support/api-harness.ts';

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
				body: JSON.stringify({
					name: 'capacity-live-acceptance-isolated',
					displayName: 'Capacity acceptance isolated',
					metadata: { liveAcceptance: true },
				}),
			});
			expect(isolatedTeam.status).toBe(200);
			const isolatedTeamPayload = await json(isolatedTeam);
			const isolatedTeamId = isolatedTeamPayload.payload.id;
			const cleanupInventory = await json(await app.request('/v1/teams', { headers }));
			expect(cleanupInventory.payload).toContainEqual(expect.objectContaining({
				id: isolatedTeamId,
				name: 'capacity-live-acceptance-isolated',
			}));
			expect(await app.request(`/v1/teams/${isolatedTeamId}/capacity-registration-key/reveal`, { headers })).toMatchObject({ status: 200 });
			const deleted = await app.request(`/v1/teams/${isolatedTeamId}/permanent-delete`, {
				method: 'DELETE',
				headers,
				body: JSON.stringify({ confirmation: 'capacity-live-acceptance-isolated', localAcceptanceCleanup: true }),
			});
			expect(deleted.status).toBe(200);
			expect(await store.getTeam(isolatedTeamId)).toBeNull();

			const listed = await json(await app.request('/v1/teams/treeseed/workday-runs', { headers }));
			expect(listed.payload.items.map((run: Record<string, unknown>) => run.id)).toContain('run-local-acceptance');
			expect(listed.payload.page).toMatchObject({ limit: 50, hasMore: false, nextCursor: null });
		} finally {
			db.close();
		}
	});
});
