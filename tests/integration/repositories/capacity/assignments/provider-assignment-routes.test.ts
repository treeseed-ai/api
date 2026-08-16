import { Hono } from 'hono';
import { describe,expect,it } from 'vitest';
import type { CapacityProviderAccessEnv } from '../../../../../src/api/capacity/provider-access-middleware.ts';
import { installProviderAssignmentRoutes } from '../../../../../src/api/capacity/routes/capacity/assignments/provider-assignments.ts';

const principal = {
	membershipId: 'membership-a',
	teamId: 'team-a',
	capacityProviderId: 'provider-a',
	scopes: ['provider:assignments:read', 'provider:assignments:write', 'provider:usage:write'],
};

function application(store: Record<string, unknown>, scopes = principal.scopes) {
	store={first:async()=>null,all:async()=>[],...store};
	const app = new Hono<CapacityProviderAccessEnv>();
	app.use('*', async (c, next) => {
		c.set('capacityProviderAccessAuth', { principal: { ...principal, scopes } });
		await next();
	});
	installProviderAssignmentRoutes(app as unknown as Hono, { store: store as never });
	return app;
}

describe('provider assignment routes', () => {
	it('delegates lease and lifecycle transitions through the canonical store owners', async () => {
		const calls: string[] = [];
		const assignment = { id: 'assignment-a', capacityProviderId: 'provider-a' };
		const store = {
			async leaseNextProviderAssignment() { calls.push('next'); return { assignment, leaseToken: 'lease-a', leaseSeconds: 30, diagnostics: { selected: true } }; },
			async renewProviderAssignmentLease() { calls.push('renew'); return { assignment, leaseToken: 'lease-b', leaseSeconds: 30 }; },
			async returnProviderAssignment() { calls.push('return'); return { assignment }; },
			async preflightProviderAssignmentCompletion() { calls.push('preflight'); return { assignmentId:'assignment-a',receiptDigest:'a'.repeat(64) }; },
			async completeProviderAssignment() { calls.push('complete'); return { assignment }; },
			async failProviderAssignment() { calls.push('fail'); return { assignment }; },
		};
		const app = application(store);
		for (const path of ['next', 'assignment-a/renew', 'assignment-a/return', 'assignment-a/completion-preflight', 'assignment-a/complete', 'assignment-a/fail']) {
			const response = await app.request(`/v1/provider/assignments/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
			expect(response.status, path).toBe(200);
		}
		expect(calls).toEqual(['next', 'renew', 'return', 'preflight', 'complete', 'fail']);
	});

	it('long-polls one exact lane without weakening lane provenance',async()=>{
		const requests:Record<string,unknown>[]=[];let attempts=0;
		const response=await application({async leaseNextProviderAssignment(_principal:unknown,input:Record<string,unknown>){requests.push(input);attempts+=1;return attempts<2?{assignment:null,diagnostics:{empty:true}}:{assignment:{id:'assignment-lane',capacityProviderId:'provider-a',laneId:'communication-1',lanePurpose:'communication'},leaseToken:'lease-lane',leaseSeconds:30};}}).request('/v1/provider/assignments/next',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({laneId:'communication-1',lanePurpose:'communication',waitSeconds:0.05})});
		expect(response.status).toBe(200);expect(attempts).toBe(2);expect(requests.every((request)=>request.laneId==='communication-1'&&request.lanePurpose==='communication')).toBe(true);expect(await response.json()).toMatchObject({assignment:{id:'assignment-lane',lanePurpose:'communication'}});
	});

	it('records client_unavailable without blocking a communication runner', async () => {
		let action: Record<string, unknown> | null = null;
		const assignment = {
			id: 'assignment-chat', teamId: 'team-a', projectId: 'project-a', capacityProviderId: 'provider-a',
			status: 'leased', leaseState: 'leased', leaseToken: 'lease-chat', stateVersion: 3,
			invocationId: 'invocation-chat',
		};
		const response = await application({
			async getProviderAssignment() { return assignment; },
			async first(query: string) {
				if (query.includes('agent_invocation_requests')) return { requested_by_id: 'user-a' };
				if (query.includes('agent_client_sessions')) return null;
				if (query.includes('agent_client_actions')) return action;
				return null;
			},
			async run(query: string, params: unknown[]) {
				if (query.includes('INSERT INTO agent_client_actions')) action = {
					id: params[0], session_id: params[1], assignment_id: params[2], user_id: params[3],
					team_id: params[4], project_id: params[5], kind: params[6], status: params[8], result_json: params[12],
				};
				return { changes: 1 };
			},
		}).request('/v1/provider/assignments/assignment-chat/client-actions', {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ leaseToken: 'lease-chat', expectedStateVersion: 3, idempotencyKey: 'action-a', kind: 'navigate', payload: { resourceId: 'proposal-a' } }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, payload: { assignment_id: 'assignment-chat', user_id: 'user-a', status: 'unavailable' } });
		expect(JSON.parse(String(action?.result_json))).toEqual({ code: 'client_unavailable' });
	});

	it('enforces assignment ownership and all mode-run scopes before mutation', async () => {
		let created = false;
		const store = {
			async getProviderAssignment() { return { id: 'assignment-b', capacityProviderId: 'provider-b' }; },
			async createAgentModeRun() { created = true; return { id: 'mode-a' }; },
		};
		const forbidden = await application(store).request('/v1/provider/assignments/assignment-b/mode-runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
		expect(forbidden.status).toBe(403);
		expect(created).toBe(false);

		const missingScope = await application(store, ['provider:assignments:write']).request('/v1/provider/assignments/assignment-b/mode-runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
		expect(missingScope.status).toBe(403);
		expect(await missingScope.json()).toMatchObject({ code: 'provider_scope_required', details: { missingScopes: ['provider:usage:write'] } });
	});

	it('promotes live mode-run telemetry to the owning workday run activity stream', async () => {
		const events: Array<{ teamId: string; runId: string; input: Record<string, unknown> }> = [];
		const assignment = {
			id: 'assignment-a', teamId: 'team-a', projectId: 'project-a', capacityProviderId: 'provider-a',
			workDayId: 'workday-run-a-project-a', agentId: 'evidence-researcher',
			metadata: { workdayRunId: 'run-a' },
		};
		const response = await application({
			async getProviderAssignment() { return assignment; },
			async createAgentModeRun() { return { id: 'mode-a', providerAssignmentId: assignment.id, status: 'running' }; },
			async createCapacityWorkdayEvent(teamId: string, runId: string, input: Record<string, unknown>) {
				events.push({ teamId, runId, input }); return { id: 'event-a' };
			},
		}).request('/v1/provider/assignments/assignment-a/mode-runs', {
			method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
		});
		expect(response.status).toBe(201);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			teamId: 'team-a', runId: 'run-a',
			input: { assignmentId: 'assignment-a', modeRunId: 'mode-a', workdayId: 'workday-run-a-project-a' },
		});
	});

	it('requires usage scope when failure reports financial evidence', async () => {
		let failed = false;
		const response = await application({
			async failProviderAssignment() { failed = true; return null; },
		}, ['provider:assignments:write']).request('/v1/provider/assignments/assignment-a/fail', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ usageActualId: 'usage-a' }),
		});
		expect(response.status).toBe(403);
		expect(failed).toBe(false);
	});

	it('persists sanitized provider runtime events against the owning workday', async () => {
		const events: Record<string, unknown>[] = [];
		const response = await application({
			async getProviderAssignment() { return {
				id: 'assignment-a', teamId: 'team-a', projectId: 'project-a', capacityProviderId: 'provider-a',
				workDayId: 'workday-a', agentId: 'guide-steward', projectAgentClassId: 'class-a', handlerId: 'writer',
				decisionInput: { activityType: 'planning' }, metadata: { workdayRunId: 'run-a' },
			}; },
			async createCapacityWorkdayEvent(teamId: string, runId: string, input: Record<string, unknown>) {
				events.push({ teamId, runId, input }); return input;
			},
		}).request('/v1/provider/assignments/assignment-a/events', {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id: 'lease-failed-1', eventType: 'provider.assignment.lease_renew_failed', status: 'failed', component: 'lease', message: 'Renewal rejected.', context: { accessToken: 'secret', attempt: 2 } }),
		});
		expect(response.status).toBe(201);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ teamId: 'team-a', runId: 'run-a', input: {
			id: 'provider-runtime:assignment-a:lease-failed-1', assignmentId: 'assignment-a',
			eventType: 'provider.assignment.lease_renew_failed', status: 'failed',
			context: { component: 'lease', accessToken: '<redacted>', attempt: 2 },
		} });
	});

	it('returns Zod-validated forensic activity only for the provider-owned assignment', async () => {
		const event = (id: string, eventIndex: number, assignmentId: string) => ({
			id, eventIndex, eventType: 'tool.completed', status: 'completed', title: 'Tool completed', message: 'Verification completed.',
			teamId: 'team-a', projectId: 'project-a', runId: 'run-a', workdayId: 'workday-a', assignmentId, modeRunId: null,
			createdAt: '2026-08-12T14:00:00.000Z', context: { agentId: 'engineer', agentClassId: 'engineering' }, refs: {}, metadata: { redactionStatus: 'sanitized' },
		});
		const response = await application({
			async getProviderAssignment() { return { id: 'assignment-a', capacityProviderId: 'provider-a', metadata: { workdayRunId: 'run-a' } }; },
			async listCapacityWorkdayEventsPage() { return { items: [event('event-a', 1, 'assignment-a'), event('event-b', 2, 'assignment-b')] }; },
		}).request('/v1/provider/assignments/assignment-a/activity?after=-1&limit=10');
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, payload: { cursor: 1, items: [{ id: 'event-a', assignmentId: 'assignment-a', redactionStatus: 'sanitized' }] } });
	});
});
