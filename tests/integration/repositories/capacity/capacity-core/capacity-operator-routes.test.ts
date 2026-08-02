import { encodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { Hono } from 'hono';
import { describe,expect,it } from 'vitest';
import { CapacityGovernanceError,type CapacityGovernanceDatabase } from '../../../../../src/api/capacity/database.ts';
import { installCapacityOperatorRoutes } from '../../../../../src/api/capacity/routes/support/operator.ts';

describe('capacity operator routes', () => {
	it('preserves fail-closed workday governance status and code at the HTTP boundary', async () => {
		const app = new Hono();
		const store = {
			async createCapacityWorkdayRun() {
				throw new CapacityGovernanceError('capacity_workday_treedx_binding_missing', 'Workday requires a configured TreeDX repository.', 409);
			},
		} as unknown as CapacityGovernanceDatabase;
		installCapacityOperatorRoutes(app, {
			store,
			async requireTeamAccess() { return { principal: { id: 'owner-a' } }; },
		});
		const response = await app.request('/v1/teams/team-a/workday-runs', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ status: 'running' }),
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			ok: false,
			error: 'Workday requires a configured TreeDX repository.',
			code: 'capacity_workday_treedx_binding_missing',
		});
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

	it('routes idempotent tick, cancellation, and safe requeue with the managing actor', async () => {
		const app = new Hono(); const calls: Array<Record<string, unknown>> = [];
		const store = {
			async tickCapacityWorkdayRun(teamId: string, runId: string, now: string | undefined, idempotencyKey: string) {
				calls.push({ operation: 'tick', teamId, runId, now, idempotencyKey }); return { runId };
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
		const cancel = await app.request('/v1/teams/team-a/capacity/assignments/assignment-a/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idempotencyKey: 'cancel-a', reason: 'No longer needed.' }) });
		const requeue = await app.request('/v1/teams/team-a/capacity/assignments/assignment-a/requeue', { method: 'POST', headers: { 'Idempotency-Key': 'retry-a' } });
		expect([tick.status, cancel.status, requeue.status]).toEqual([200, 200, 200]);
		expect(calls).toEqual([
			{ operation: 'tick', teamId: 'team-a', runId: 'run-a', now: undefined, idempotencyKey: 'tick-a' },
			{ operation: 'cancel', teamId: 'team-a', assignmentId: 'assignment-a', idempotencyKey: 'cancel-a', actorId: 'owner-a', reason: 'No longer needed.' },
			{ operation: 'requeue', teamId: 'team-a', assignmentId: 'assignment-a', idempotencyKey: 'retry-a', actorId: 'owner-a' },
		]);
	});
});
