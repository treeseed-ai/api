import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { canonicalStandardsJson } from '@treeseed/sdk/standards';
import { assignment } from '../../fixtures/assignment.ts';
import { workdayReportContext } from '../../../../../../../src/api/capacity/services/capacity/assignments/admission/workday-report-context.ts';
import { splitPostgresSqlStatements } from '../../../../../../../src/api/persistence/postgres-sql-statements.ts';
import { advanceLivingWorkday } from '../../../../../../../src/api/capacity/services/capacity/workdays/lifecycle/living-workday-lifecycle.ts';
import { closeoutDatabase, now, reportRef, reportResult } from './closeout-sql-fixture.ts';

describe('canonical single report at the real lifecycle and SQL boundary', () => {
	it('native Reporter snapshot retains the exact original teardown result rather than an absent status scalar without repairing evidence or changing SQL history', async () => {
		const f = await closeoutDatabase(); try {
			const usageDdl = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'))
				.filter(sql => sql.startsWith('CREATE TABLE "capacity_usage_actuals" ('));
			expect(usageDdl).toHaveLength(1); await f.db.exec(usageDdl[0]!);
			const teardown = { verified: true, completedAt: now, resources: [{ id: 'owned-workspace', state: 'closed' }] };
			const lifecycle = { teardown, activityCompletion: { reviewDisposition: 'request-changes' } };
			await f.query('UPDATE capacity_provider_assignments SET lifecycle_output_json=?', [JSON.stringify(lifecycle)]);
			const input = assignmentAttemptSchema.parse({ ...assignment, sourceRef: { store: 'postgresql', model: 'workday',
				id: 'workday', revision: 1, digest: `sha256:${'a'.repeat(64)}` },
				effectiveProfile: { ...assignment.effectiveProfile, activity: 'reporting' } });
			const original = structuredClone(input), baseline = (await f.query('SELECT * FROM capacity_provider_assignments')).rows;
			const [context] = await workdayReportContext(f.owner, input);
			expect(context.ref).toEqual(input.sourceRef);
			expect(context.value).toMatchObject({ teamId: 'team', workdayId: 'workday', attempts: [
				{ id: 'assignment-report', teardown_result: teardown, teardown_status: null, review_disposition: 'request-changes' },
			] });
			expect(context.digest).toBe(`sha256:${createHash('sha256').update(canonicalStandardsJson(context.value)).digest('hex')}`);
			expect(await workdayReportContext(f.owner, input)).toEqual([context]);
			expect((await f.query('SELECT * FROM capacity_provider_assignments')).rows).toEqual(baseline);
			expect(input).toEqual(original);
		} finally { await f.db.close(); }
	});
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
