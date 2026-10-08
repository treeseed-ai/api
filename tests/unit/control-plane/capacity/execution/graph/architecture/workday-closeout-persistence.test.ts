import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appliedWorkdaySchema, assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { canonicalStandardsJson } from '@treeseed/sdk/standards';
import { assignment } from '../../fixtures/assignment.ts';
import { workdayReportContext } from '../../../../../../../src/api/capacity/services/capacity/assignments/admission/workday-report-context.ts';
import { advanceLivingWorkday } from '../../../../../../../src/api/capacity/services/capacity/workdays/lifecycle/living-workday-lifecycle.ts';
import { closeoutDatabase, now, reportRef, reportResult } from './closeout-sql-fixture.ts';
import { settlementDatabase, terminalUsage } from '../../../accounting/architecture/settlement-fixture.ts';
import { settleCapacityReservationExactlyOnce } from '../../../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts';
import { cancellationDatabase } from '../../../../providers/assignments/architecture/cancellation-fixture.ts';
import { createWorkdayService } from '../../../../../../../src/api/control-plane/repositories/capacity/workday-service.ts';
import { terminalizeCapacityWorkdayAssignments } from '../../../../../../../src/api/capacity/services/capacity/workdays/lifecycle/workday-assignment-terminalization-service.ts';

describe('canonical single report at the real lifecycle and SQL boundary', () => {
	it('native migration retains unreported ended history as an explicit failed closing workday without fabricating a report or changing valid runs', async () => {
		const f = await closeoutDatabase();
		try {
			const run = (await f.reads.get('team', 'workday'))!;
			const invalid = { ...appliedWorkdaySchema.parse(run.parameters.appliedPlan), state: 'ended', endedAt: now };
			await f.query("UPDATE capacity_workday_runs SET status='cancelled',completed_at=?,parameters_json=?,error_json=?", [now,
				JSON.stringify({ ...run.parameters, appliedPlan: invalid }), JSON.stringify({ originalFailure: 'retained' })]);
			const original = (await f.query('SELECT * FROM capacity_workday_runs')).rows[0]!;
			const heldAssignments = (await f.query('SELECT * FROM capacity_provider_assignments')).rows;
			const heldAudit = (await f.query('SELECT * FROM audit_events')).rows;
			await expect(f.reads.get('team', 'workday')).rejects.toThrow('An ended workday requires');
			const migration = readFileSync('drizzle/control-plane/0046_repair_unreported_workday_closeout.sql', 'utf8');
			await f.db.exec(migration);
			const repaired = (await f.reads.get('team', 'workday'))!;
			expect(repaired).toMatchObject({ status: 'failed', completedAt: now,
				error: { originalFailure: 'retained', code: 'workday_closeout_report_missing', unreportedEndedPlan: invalid } });
			expect(appliedWorkdaySchema.parse(repaired.parameters.appliedPlan)).toMatchObject({ state: 'closing', closingAt: now });
			expect(repaired.parameters.appliedPlan).not.toHaveProperty('reportRef');
			expect(repaired.parameters.appliedPlan).not.toHaveProperty('endedAt');
			const retained = (await f.query('SELECT * FROM capacity_workday_runs')).rows;
			await f.db.exec(migration); expect((await f.query('SELECT * FROM capacity_workday_runs')).rows).toEqual(retained);
			for (const column of ['summary_json', 'report_refs_json', 'completed_at', 'created_at', 'updated_at'])
				expect(retained[0]![column]).toEqual(original[column]);
			await f.query('UPDATE capacity_workday_runs SET status=?,parameters_json=?', ['completed',
				JSON.stringify({ ...run.parameters, appliedPlan: { ...invalid, reportRef } })]);
			const valid = (await f.query('SELECT * FROM capacity_workday_runs')).rows;
			await f.db.exec(migration); expect((await f.query('SELECT * FROM capacity_workday_runs')).rows).toEqual(valid);
			expect((await f.query('SELECT * FROM capacity_provider_assignments')).rows).toEqual(heldAssignments);
			expect((await f.query('SELECT * FROM audit_events')).rows).toEqual(heldAudit);
		} finally { await f.db.close(); }
	});
	it('native public operator stop retains the closing Reporter node and canonical reads until its exact completed report and settlement', async () => {
		const f = await cancellationDatabase('returned', false);
		try {
			await f.query("UPDATE execution_nodes SET kind='acting' WHERE id='report-node'");
			await f.query(`INSERT INTO execution_nodes (id,team_id,project_id,workday_id,kind,source_ref_json,rule_revision,
				node_revision,agent_class,status,graph_revision_created,graph_revision_updated,created_at,updated_at)
				VALUES ('closing-report','team','project','workday','reporting','{}',1,1,'renamed-closeout','ready',1,1,?,?)`, [now, now]);
			const sourceAttempt = JSON.stringify(f.attempt), store = { ...f.owner,
				updateCapacityWorkdayRun: f.store.updateCapacityWorkdayRun,
				getCapacityWorkdayRun: (team: string, id: string) => f.reads.get(team, id),
				terminalizeCapacityWorkdayAssignments: (team: string, id: string, input: Parameters<typeof terminalizeCapacityWorkdayAssignments>[3]) =>
					terminalizeCapacityWorkdayAssignments(f.owner, team, id, input) };
			const service = createWorkdayService(store), principal = { id: 'operator', roles: ['platform_admin'] };
			for (let retry = 0; retry < 2; retry++) {
				const response = await service.stop(principal, 'team', 'workday', { reason: 'retain failed run' });
				expect(response.run).toMatchObject({ status: 'running', parameters: { appliedPlan: { state: 'closing' } } });
				expect((await f.query('SELECT id,status FROM execution_nodes ORDER BY id')).rows).toEqual([
					{ id: 'closing-report', status: 'ready' }, { id: 'report-node', status: 'cancelled' }]);
				expect((await f.query('SELECT assignment_attempt_json FROM capacity_provider_assignments')).rows)
					.toEqual([{ assignment_attempt_json: sourceAttempt }]);
			}
			const beforeReport = await f.snapshot();
			await f.query("UPDATE execution_nodes SET status='completed' WHERE id='closing-report'");
			const result = { ...reportResult, id: 'result-closeout', assignmentId: 'assignment-closeout' };
			await f.query(`INSERT INTO capacity_provider_assignments (id,membership_id,team_id,project_id,capacity_provider_id,
				project_agent_class_id,work_day_id,mode,status,execution_node_id,assignment_result_json,completed_at,created_at,updated_at)
				VALUES ('assignment-closeout','membership','team','project','provider','renamed-closeout','workday','acting',
				'completed','closing-report',?,?,?,?)`, [JSON.stringify(result), now, now, now]);
			await f.query(`INSERT INTO audit_events (id,actor_type,event_type,target_type,target_id,data_json,created_at)
				VALUES ('closeout-integrated','service','assignment.content.integrated','capacity_provider_assignment','assignment-closeout','{}',?)`, [now]);
			const run = (await f.reads.get('team', 'workday'))!;
			const outcome = await advanceLivingWorkday(store, run, new Date().toISOString());
			expect(outcome).toMatchObject({ status: 'cancelled', plan: { state: 'ended', reportRef } });
			const terminal = (await f.reads.get('team', 'workday'))!;
			expect(appliedWorkdaySchema.parse(terminal.parameters.appliedPlan).reportRef).toEqual(reportRef);
			expect((await advanceLivingWorkday(store, terminal, new Date().toISOString())).changed).toBe(false);
			for (const table of ['capacity_usage_actuals', 'capacity_ledger_entries', 'capacity_reservations'])
				expect((await f.query(`SELECT * FROM ${table} ORDER BY 1,2`)).rows).toEqual(beforeReport[table]);
		} finally { await f.db.close(); }
	});
	it('native Reporter snapshot retains the exact original teardown result rather than an absent status scalar without repairing evidence or changing SQL history', async () => {
		const f = await settlementDatabase(); try {
			await settleCapacityReservationExactlyOnce(f.owner, { ...terminalUsage });
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
			const privateReceipt = { ...teardown, accessToken: 'controlled-private-input', resources: [
				{ ...teardown.resources[0]!, credential: { value: 'controlled-private-input' } },
			] };
			await f.query('UPDATE capacity_provider_assignments SET lifecycle_output_json=?', [JSON.stringify({ ...lifecycle, teardown: privateReceipt })]);
			const retained = (await f.query('SELECT * FROM capacity_provider_assignments')).rows;
			expect(await workdayReportContext(f.owner, input)).toEqual([context]);
			expect((await f.query('SELECT * FROM capacity_provider_assignments')).rows).toEqual(retained);
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
