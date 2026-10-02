import { describe, expect, it } from 'vitest';
import { advanceLivingWorkday } from '../../../../../../../src/api/capacity/services/capacity/workdays/lifecycle/living-workday-lifecycle.ts';
import { closeoutDatabase, now, reportRef, reportResult } from './closeout-sql-fixture.ts';

describe('canonical single report at the real lifecycle and SQL boundary', () => {
	it.each(['failed', 'cancelled', 'stale'])('retains %s Reporter failure through SQL without an unreported ended workday', async status => {
		const { db, reads, store, query } = await closeoutDatabase();
		try {
			await query('UPDATE execution_nodes SET status=?', [status]);
			const run = (await reads.get('team', 'workday'))!;
			const outcome = await advanceLivingWorkday(store as never, run, now);
			expect(outcome.status).toBe('failed');
			expect(outcome.plan.state).not.toBe('ended');
			expect((await reads.get('team', 'workday'))!.parameters.appliedPlan).toMatchObject({ state: 'closing' });
			expect((await query('SELECT status FROM execution_nodes')).rows).toEqual([{ status }]);
		} finally { await db.close(); }
	});
	it('persists exactly one canonical workday report from the completed result without a plural authority map', async () => {
		const { db, reads, store, query } = await closeoutDatabase();
		try {
			const run = (await reads.get('team', 'workday'))!;
			const original = structuredClone(run);
			const result = await advanceLivingWorkday(store as never, run, now);
			expect(result).toMatchObject({ status: 'completed', plan: { state: 'ended', reportRef } });
			expect(run).toEqual(original);
			const rows = (await query('SELECT parameters_json,report_refs_json FROM capacity_workday_runs')).rows;
			expect(rows).toHaveLength(1);
			expect(JSON.parse(String(rows[0]!.parameters_json)).appliedPlan.reportRef).toEqual(reportRef);
			expect(JSON.parse(String(rows[0]!.report_refs_json))).toEqual({});
			const settled = (await reads.get('team', 'workday'))!;
			expect(settled.parameters.appliedPlan).toMatchObject({ state: 'ended', reportRef });
			const repeated = await advanceLivingWorkday(store as never, settled, now);
			expect(repeated.changed).toBe(false);
			expect((await query('SELECT COUNT(*)::int AS count FROM capacity_workday_runs')).rows).toEqual([{ count: 1 }]);
		} finally { await db.close(); }
	});

	it('does not end or publish a report while its actual reservation remains consuming', async () => {
		const { db, reads, store, query } = await closeoutDatabase();
		try {
			await query("UPDATE capacity_reservations SET state='consuming'");
			const run = (await reads.get('team', 'workday'))!;
			expect(await advanceLivingWorkday(store as never, run, now)).toMatchObject({ status: 'running', plan: { state: 'closing' } });
			const observed = (await reads.get('team', 'workday'))!;
			expect(observed.parameters.appliedPlan).not.toHaveProperty('reportRef');
			expect(observed.reportRefs).toEqual({});
		} finally { await db.close(); }
	});

	it('denies future result completion at the real SQL closeout boundary', async () => {
		const { db, reads, store, query } = await closeoutDatabase();
		try {
			await query('UPDATE capacity_provider_assignments SET assignment_result_json=?',
				[JSON.stringify({ ...reportResult, completedAt: '2026-10-02T21:02:00.000Z' })]);
			const run = (await reads.get('team', 'workday'))!;
			const outcome = await advanceLivingWorkday(store as never, run, now);
			expect(outcome.status).not.toBe('completed');
			expect(outcome.plan.state).not.toBe('ended');
			expect((await reads.get('team', 'workday'))!.parameters.appliedPlan).not.toHaveProperty('reportRef');
		} finally { await db.close(); }
	});
});
