import { encodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { Hono } from 'hono';
import { describe,expect,it } from 'vitest';
import type { CapacityGovernanceDatabase } from '../../../../../src/api/capacity/database.ts';
import { installCapacityOperatorRoutes } from '../../../../../src/api/capacity/routes/support/operator.ts';

describe('capacity operator routes', () => {
	it('preflights a workday through the managing boundary without creating the run', async () => {
		const app = new Hono();
		let creates = 0;
		const calls: Array<Record<string, unknown>> = [];
		const schedulerProjection = {
			ok: true, teamId: 'team-a', providerId: 'provider-a', allocationSetId: 'allocation-a',
			projects: [{ id: 'project-a', slug: 'market', repositoryId: 'repo-a', planningGraphRevision: 'revision-a', agentProfiles: 6 }],
			availableSeconds: 6_000, planningSeconds: 5_400, requiredSeconds: 5_100, rounds: 3, waves: 5, participants: 6,
		};
		const store = {
			async ensureInitialized() {},
			async first(query:string) { return query.includes('capacity_allocation_sets')?{id:'allocation-a',state_version:2,status:'active'}:null; },
			async all(query:string) { return query.includes('capacity_provider_team_memberships')?[{capacity_provider_id:'provider-a'}]:[]; },
			async run() {},
			async createCapacityWorkdayRun() { creates += 1; return {}; },
			async preflightCapacityWorkdayRunRequest(teamId: string, input: Record<string, unknown>) {
				calls.push({ teamId, ...input });
				return schedulerProjection;
			},
		} as unknown as CapacityGovernanceDatabase;
		installCapacityOperatorRoutes(app, {
			store,
			async requireTeamAccess(_c, _store, _teamId, permission) {
				expect(permission).toBe('teams:manage:team');
				return { principal: { id: 'owner-a' } };
			},
		});
		const response = await app.request('/v1/teams/team-a/workday-runs/preflight', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ schemaVersion:'treeseed.workday-intent/v1',profileId:'allocation-a',projects:['market'],startsAt:new Date(Date.now()+60_000).toISOString(),durationSeconds:3_000 }),
		});
		expect(response.status).toBe(200);
		const responseBody=await response.json() as any;
		expect(responseBody).toMatchObject({ok:true,payload:{schemaVersion:'treeseed.workday-preflight/v1',teamId:'team-a',profileId:'allocation-a',profileGeneration:2,maxConcurrency:1}});
		expect(responseBody.payload.preflightDigest).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/u);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({teamId:'team-a',capacityProviderId:'provider-a',status:'running',requestedById:'owner-a',parameters:{allocationSetId:'allocation-a',durationSeconds:3_000,planningOnly:false}});
		expect(creates).toBe(0);
	});

	it('rejects raw derived workday fields before any scheduler mutation', async () => {
		const app = new Hono();
		let creates=0;
		const store = {
			async createCapacityWorkdayRun() { creates+=1; return {}; },
		} as unknown as CapacityGovernanceDatabase;
		installCapacityOperatorRoutes(app, {
			store,
			async requireTeamAccess() { return { principal: { id: 'owner-a' } }; },
		});
		const response = await app.request('/v1/teams/team-a/workday-runs/preflight', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ profileId:'profile-a',projects:'all',startsAt:new Date().toISOString(),durationSeconds:300,status:'running',parameters:{} }),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ok:false,code:'workday_intent_derived_fields_forbidden'});
		expect(creates).toBe(0);
	});

	it('serves the assignment-owned explanation without a duplicate explanation repository', async () => {
		const app = new Hono();
		const explanation = { source: 'workday_demand', eligible: true, reasons: ['governed admission'], gates: { allocationSetId: 'allocation-a' } };
		const store = {
			async getProviderAssignment() { return { id: 'assignment-a', explanation }; },
		} as unknown as CapacityGovernanceDatabase;
		installCapacityOperatorRoutes(app, {
			store,
			async requireTeamAccess() { return { principal: { id: 'reader-a' } }; },
		});
		const response = await app.request('/v1/teams/team-a/capacity/assignments/assignment-a/explanation');
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, payload: explanation });
	});

	it('routes exact assignment filters and bounded keyset pages to the assignment repository', async () => {
		const app = new Hono();
		const calls: Array<Record<string, unknown>> = [];
		const page = {
			items: [{ id: 'assignment-a' }],
			page: { limit: 1, hasMore: false, nextCursor: null },
		};
		const store = {
			async listProviderAssignmentsPage(teamId: string, filters: Record<string, unknown>) {
				calls.push({ teamId, ...filters });
				return page;
			},
		} as unknown as CapacityGovernanceDatabase;
		installCapacityOperatorRoutes(app, {
			store,
			async requireTeamAccess() { return { principal: { id: 'reader-a' } }; },
		});

		const response = await app.request('/v1/teams/team-a/capacity/assignments?assignmentId=assignment-a&workdayId=workday-a&executionProviderId=codex-a&limit=1');
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, payload: page });
		expect(calls).toEqual([{
			teamId: 'team-a',
			projectId: null,
			providerId: null,
			status: null,
			assignmentId: 'assignment-a',
			workdayId: 'workday-a',
			executionProviderId: 'codex-a',
			limit: 1,
			cursor: null,
		}]);
	});

	it('rejects invalid assignment page limits at the HTTP boundary', async () => {
		const app = new Hono();
		const store = {} as CapacityGovernanceDatabase;
		installCapacityOperatorRoutes(app, {
			store,
			async requireTeamAccess() { return { principal: { id: 'reader-a' } }; },
		});

		const response = await app.request('/v1/teams/team-a/capacity/assignments?limit=201');
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			ok: false,
			code: 'capacity_page_invalid',
		});
	});

	it('routes bounded workday, session, event, and execution pages through one cursor contract', async () => {
		const app = new Hono();
		const calls: Array<Record<string, unknown>> = [];
		const result = { items: [], page: { limit: 1, hasMore: false, nextCursor: null } };
		const store = {
			async listCapacityWorkdayRunsPage(teamId: string, filters: Record<string, unknown>) { calls.push({ collection: 'runs', teamId, ...filters }); return result; },
			async getCapacityWorkdayRun() { return { id: 'run-a' }; },
			async listCapacityWorkdayEventsPage(teamId: string, runId: string, filters: Record<string, unknown>) { calls.push({ collection: 'events', teamId, runId, ...filters }); return result; },
			async listProviderAvailabilitySessionsPage(teamId: string, filters: Record<string, unknown>) { calls.push({ collection: 'sessions', teamId, ...filters }); return result; },
			async listExecutionRunsForTeamPage(teamId: string, filters: Record<string, unknown>) { calls.push({ collection: 'executions', teamId, ...filters }); return result; },
		} as unknown as CapacityGovernanceDatabase;
		installCapacityOperatorRoutes(app, {
			store,
			async requireTeamAccess() { return { principal: { id: 'reader-a' } }; },
		});
		const cursor = encodeCapacityPageCursor({ createdAt: '2026-01-01T00:00:00.000Z', id: 'cursor-id' });
		const suffix = `limit=1&cursor=${encodeURIComponent(cursor)}`;
		for (const path of [
			`/v1/teams/team-a/workday-runs?${suffix}`,
			`/v1/teams/team-a/workday-runs/run-a/events?${suffix}`,
			`/v1/teams/team-a/capacity/availability-sessions?${suffix}`,
			`/v1/teams/team-a/capacity/execution-runs?${suffix}`,
		]) {
			const response = await app.request(path);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ ok: true, payload: result });
		}
		expect(calls.map((call) => call.collection)).toEqual(['runs', 'events', 'sessions', 'executions']);
		expect(calls.every((call) => call.limit === 1 && (call.cursor as { id?: string } | null)?.id === 'cursor-id')).toBe(true);
	});

	it('projects compact execution activity without repeated snapshots', async () => {
		const app = new Hono();
		const store = {
			async listExecutionRunsForTeamPage() {
				return { items: [{
					id: 'run-a', status: 'succeeded', agent: { agentId: 'writer' },
					input: { selectedInput: { cycle: 2, body: 'omit' }, decisionInput: { repeated: true } },
					output: { outputs: { executionSnapshot: 'omit' } }, modeRuns: [{ outputs: 'omit' }],
				}], page: { limit: 1, hasMore: false, nextCursor: null } };
			},
		} as unknown as CapacityGovernanceDatabase;
		installCapacityOperatorRoutes(app, { store, async requireTeamAccess() { return { principal: { id: 'reader-a' } }; } });
		const response = await app.request('/v1/teams/team-a/capacity/execution-runs?projection=activity&limit=1');
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, payload: {
			items: [{ id: 'run-a', status: 'succeeded', agent: { agentId: 'writer' }, input: { selectedInput: { cycle: 2 } } }],
			page: { limit: 1, hasMore: false, nextCursor: null },
		} });
	});

	it('serves compact ordered workday activity after a durable sequence cursor', async () => {
		const app = new Hono();
		const store = {
			async getCapacityWorkdayRun() { return { id: 'run-a' }; },
			async listCapacityWorkdayEventsPage(_teamId: string, _runId: string, filters: Record<string, unknown>) {
				expect(filters).toMatchObject({ afterEventIndex: 3, limit: 200 });
				return { items: [{ id: 'event-4', runId: 'run-a', teamId: 'team-a', projectId: 'project-a', workdayId: 'run-a', assignmentId: 'assignment-a', modeRunId: 'mode-a', eventIndex: 4, eventType: 'item.completed', status: 'recorded', title: 'agent_message', message: 'Drafted.', parameters: {}, context: { agentId: 'writer', agentClassId: 'guide-writing' }, refs: {}, metadata: { severity: 'info', payloadDigest: 'digest' }, createdAt: '2026-08-02T12:00:00.000Z' }], page: { limit: 200, hasMore: false, nextCursor: null } };
			},
		} as unknown as CapacityGovernanceDatabase;
		installCapacityOperatorRoutes(app, { store, async requireTeamAccess() { return { principal: { id: 'reader-a' } }; } });
		const response = await app.request('/v1/teams/team-a/workday-runs/run-a/activity?after=3&agent=writer');
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ payload: { cursor: 4, items: [{ sequence: 4, agentId: 'writer', summary: 'Drafted.' }] } });
	});

	it('keeps scheduler internals private while routing assignment cancellation and retry', async () => {
		const app = new Hono(); const calls: Array<Record<string, unknown>> = [];
		const store = {
			async tickCapacityWorkdayRun(teamId: string, runId: string, now: string | undefined, idempotencyKey: string) {
				calls.push({ operation: 'tick', teamId, runId, now, idempotencyKey }); return { runId };
			},
			async fenceCapacityWorkdayAdmission(teamId: string,runId: string) {
				calls.push({ operation: 'close-admission',teamId,runId }); return { runId,ready: true,successful: true };
			},
			async cancelCapacityAssignment(teamId: string, assignmentId: string, input: Record<string, unknown>) {
				calls.push({ operation: 'cancel', teamId, assignmentId, ...input }); return { id: assignmentId, status: 'cancelled' };
			},
			async requeueCapacityAssignment(teamId: string, assignmentId: string, input: Record<string, unknown>) {
				calls.push({ operation: 'requeue', teamId, assignmentId, ...input }); return { assignment: { id: assignmentId }, demand: { id: 'demand-b' } };
			},
		} as unknown as CapacityGovernanceDatabase;
		installCapacityOperatorRoutes(app, { store, async requireTeamAccess() { return { principal: { id: 'owner-a' } }; } });
		const tick = await app.request('/v1/teams/team-a/workday-runs/run-a/tick', { method: 'POST', headers: { 'Idempotency-Key': 'tick-a' } });
		const fence = await app.request('/v1/teams/team-a/workday-runs/run-a/close-admission',{ method: 'POST',headers: { 'Idempotency-Key': 'fence-a' } });
		const cancel = await app.request('/v1/teams/team-a/capacity/assignments/assignment-a/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idempotencyKey: 'cancel-a', reason: 'No longer needed.' }) });
		const requeue = await app.request('/v1/teams/team-a/capacity/assignments/assignment-a/requeue', { method: 'POST', headers: { 'Idempotency-Key': 'retry-a' } });
		expect([tick.status,fence.status,cancel.status,requeue.status]).toEqual([404,404,200,200]);
		expect(calls).toEqual([
			{ operation: 'cancel', teamId: 'team-a', assignmentId: 'assignment-a', idempotencyKey: 'cancel-a', actorId: 'owner-a', reason: 'No longer needed.' },
			{ operation: 'requeue', teamId: 'team-a', assignmentId: 'assignment-a', idempotencyKey: 'retry-a', actorId: 'owner-a' },
		]);
	});

	it('does not expose raw workday, definition-authoring, or deployment mutation routes', async () => {
		const app=new Hono(); let writes=0;
		const store={async run(){writes+=1;},async updateCapacityWorkdayRun(){writes+=1;},async createCapacityWorkdayEvent(){writes+=1;}} as unknown as CapacityGovernanceDatabase;
		installCapacityOperatorRoutes(app,{store,async requireTeamAccess(){return {principal:{id:'owner-a'}};}});
		for(const [method,path] of [
			['PATCH','/v1/teams/team-a/workday-runs/run-a'],
			['POST','/v1/teams/team-a/workday-runs/run-a/events'],
			['POST','/v1/teams/team-a/agent-lab/surfaces/build/authoring'],
			['POST','/v1/teams/team-a/agent-deployments/plan'],
			['POST','/v1/teams/team-a/agent-deployments/execute'],
		] as const) expect((await app.request(path,{method,headers:{'content-type':'application/json'},body:'{}'})).status,path).toBe(404);
		expect(writes).toBe(0);
	});
});
