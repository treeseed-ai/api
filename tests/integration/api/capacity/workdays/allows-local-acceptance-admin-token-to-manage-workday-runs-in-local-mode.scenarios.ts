import { createTestApp,createTestPostgresDatabase,createTestStore,describe,expect,it,json,vi } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('allows local acceptance admin token to manage workday runs in local mode', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		try {
			await store.ensureInitialized();
			await store.createTeam({ id: 'treeseed', slug: 'treeseed', name: 'TreeSeed' });
			const persistedKeyLookup = vi.spyOn(store, 'authenticateTeamApiKey').mockResolvedValue({
				teamId: 'treeseed',
				keyId: 'persisted-narrow-key',
				principal: {
					id: 'team-key:persisted-narrow-key',
					displayName: 'Persisted narrow key',
					roles: ['team_api_key'],
					permissions: ['projects:read:team'],
					scopes: ['auth:me'],
					metadata: { teamId: 'treeseed' },
				},
			});
			const app = createTestApp({ db, store, config: { environment: 'local' } });
			const headers = {
				'content-type': 'application/json',
				authorization: 'Bearer tsk_local_treeseed_acceptance_admin',
			};
			const now=new Date().toISOString();
			await store.run(`INSERT INTO capacity_workday_runs (id,team_id,capacity_provider_id,scenario_id,status,environment,execution_kind,trigger_kind,hidden,requested_by_id,parameters_json,summary_json,metrics_json,expected_json,actual_json,report_refs_json,error_json,started_at,completed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[
				'run-local-acceptance','treeseed','provider-local','local-auth','queued','local','workday','manual',0,'team-key:local-capacity-acceptance',JSON.stringify({authMode:'local_acceptance_admin',durationSeconds:60}),'{}','{}','{}','{}','{}','{}',null,null,now,now,
			]);
			const preflight = await app.request('/v1/teams/treeseed/workday-runs/preflight', {
				method: 'POST',
				headers,
				body: JSON.stringify({status:'queued',parameters:{durationSeconds:60}}),
			});
			expect(preflight.status).toBe(400);
			expect(await json(preflight)).toMatchObject({code:'workday_intent_derived_fields_forbidden'});
			expect(persistedKeyLookup).not.toHaveBeenCalled();

			const event = await app.request('/v1/teams/treeseed/workday-runs/run-local-acceptance/events', {
				method: 'POST',
				headers,
				body: JSON.stringify({
					eventType: 'command.started',
					title: 'Started with local acceptance auth',
				}),
			});
			expect(event.status).toBe(404);

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
