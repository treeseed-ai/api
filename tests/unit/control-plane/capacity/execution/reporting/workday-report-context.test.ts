import { createHash } from 'node:crypto';
import { canonicalStandardsJson } from '@treeseed/sdk/standards';
import { describe, expect, it, vi } from 'vitest';
import { workdayReportContext } from '../../../../../../src/api/capacity/services/capacity/assignments/admission/workday-report-context.ts';

const assignment = { teamId: 'team', workdayId: 'workday', effectiveProfile: { activity: 'reporting' },
	sourceRef: { store: 'postgresql', model: 'workday', id: 'workday', revision: 1, digest: `sha256:${'a'.repeat(64)}` } };
const rows = { nodes: [{ id: 'actor', status: 'completed' }], edges: [{ from_node_id: 'actor', to_node_id: 'reviewer' }],
	attempts: [{ id: 'expired', status: 'expired' }, { id: 'revision', status: 'completed', teardown_status: 'verified' }],
	reservations: [{ id: 'reservation', assignment_id: 'expired', state: 'expired', released_seconds: 10 }],
	usage: [{ id: 'usage', assignment_id: 'revision', active_seconds: 12 }] };
function storeWith(state = rows) {
	return { all: vi.fn().mockResolvedValueOnce(state.nodes).mockResolvedValueOnce(state.edges)
		.mockResolvedValueOnce(state.attempts).mockResolvedValueOnce(state.reservations).mockResolvedValueOnce(state.usage)
		.mockResolvedValueOnce([]) };
}

describe('workday Reporter context', () => {
	it('reads original scoped canonical settlement authority rather than inferring settlement from consumed reservation totals', async () => {
		const store = storeWith(), original = structuredClone(rows);
		const [context] = await workdayReportContext(store as never, assignment as never);
		expect(context.value).toMatchObject({ settlements: [] });
		const ledgerQuery = store.all.mock.calls.filter(([sql]) => sql.includes('FROM capacity_ledger_entries'));
		expect(ledgerQuery).toHaveLength(1);
		expect(ledgerQuery[0]?.[1]).toEqual(['team', 'workday']);
		expect(ledgerQuery[0]?.[0]).toContain("phase='task_completed_actual_settlement'");
		expect(rows).toEqual(original);
	});
	it('retains noncredential teardown evidence while excluding nested credential custody from the public Reporter snapshot without modifying supplied rows', async () => {
		const teardown = { verified: true, completedAt: '2026-10-07T20:00:00.000Z', accessToken: 'controlled-private-input',
			resources: [{ id: 'owned-workspace', state: 'closed', credential: { value: 'controlled-private-input' } }] };
		const state = structuredClone(rows); Object.assign(state.attempts[0]!, { teardown_result: teardown });
		const original = structuredClone(state), store = storeWith(state);
		const [context] = await workdayReportContext(store as never, assignment as never);
		expect(context.value).toMatchObject({ attempts: [{ id: 'expired', status: 'expired', teardown_result: {
			verified: true, completedAt: teardown.completedAt, resources: [{ id: 'owned-workspace', state: 'closed' }],
		} }, state.attempts[1]] });
		expect(JSON.stringify(context.value)).not.toContain('controlled-private-input'); expect(state).toEqual(original);
	});
	it('snapshots failures, revisions, graph, usage and settlements through existing authority without credentials', async () => {
		const store = storeWith();
		const [item] = await workdayReportContext(store as never, assignment as never);
		expect(item.ref).toEqual(assignment.sourceRef);
		expect(item.value).toEqual({ teamId: 'team', workdayId: 'workday', ...rows, settlements: [] });
		expect(item.digest).toBe(`sha256:${createHash('sha256').update(canonicalStandardsJson(item.value)).digest('hex')}`);
		for (const [sql, parameters] of store.all.mock.calls) {
			expect(parameters).toEqual(['team', 'workday']);
			expect(sql).not.toMatch(/SELECT \*|lease_token|usage_report_token|settlement_token|treedx_proxy_handle/u);
		}
		const attemptQuery = store.all.mock.calls.find(([sql]) => sql.includes('FROM capacity_provider_assignments'));
		expect(attemptQuery?.[0]).toContain("lifecycle_output_json::jsonb #> '{teardown}' AS teardown_result");
	});
	it.each(['active-attempt', 'active-reservation'])('rejects %s before Reporter admission', async failure => {
		const state = { ...rows,
			...(failure === 'active-attempt' ? { attempts: [{ id: 'actor', status: 'running' }] }
				: { reservations: [{ ...rows.reservations[0]!, state: 'consuming' }] }) };
		await expect(workdayReportContext(storeWith(state) as never, assignment as never))
			.rejects.toMatchObject({ code: 'reporter_unsettled_workday' });
	});
	it('rejects another workday and does not fetch context for ordinary activities', async () => {
		const store = storeWith();
		await expect(workdayReportContext(store as never, { ...assignment, workdayId: 'another' } as never))
			.rejects.toMatchObject({ code: 'reporter_workday_authority_required' });
		expect(await workdayReportContext(store as never, { ...assignment, effectiveProfile: { activity: 'acting' } } as never)).toEqual([]);
		expect(store.all).not.toHaveBeenCalled();
	});
});
