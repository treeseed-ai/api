import { afterEach, describe, expect, it, vi } from 'vitest';
import { terminalizeCapacityWorkdayAssignments } from '../../../../../../../src/api/capacity/services/capacity/workdays/lifecycle/workday-assignment-terminalization-service.ts';
import { settleCapacityReservationExactlyOnce } from '../../../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts';
import { cancellationDatabase, cancelNow } from '../../../../providers/assignments/architecture/cancellation-fixture.ts';
import { terminalUsage } from '../../../accounting/architecture/settlement-fixture.ts';
import { ProviderAssignmentRepository } from '../../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';

afterEach(() => vi.useRealTimers());
function clock() { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(cancelNow)); }
// REAL owning service, repositories, original DDL and transactional PGlite.
// Supplied clocks/usage are not provider-generated measurements, authenticated
// transport, independent PostgreSQL connections or physical teardown evidence.
describe('workday terminalization retains actual assignment and settlement custody', () => {
	it('native deadline terminalization retains unknown operator-action usage and every original budget claim without fabricating zero settlement', async () => {
		for (const status of ['expired', 'failed', 'cancelled']) {
			const f = await cancellationDatabase(status, false);
			try {
				clock();
				await f.query(`UPDATE capacity_provider_assignments SET lifecycle_code='expired_lease_execution_usage_unknown',
					lifecycle_output_json=?,metadata_json=? WHERE id=?`, [
					JSON.stringify({ report: 'retained-native-candidate', usage: { elapsedSeconds: 1 } }),
					JSON.stringify({ leaseRecovery: { disposition: 'operator-action', reasonCode: 'expired_lease_execution_usage_unknown' } }),
					f.assignment.id]);
				const before = await f.snapshot(), input = { now: cancelNow, settlementKeyPrefix: 'workday-deadline',
					source: 'capacity_workday_deadline_terminalization' }, held = structuredClone(input);
				const denied = await Promise.allSettled([terminalizeCapacityWorkdayAssignments(f.owner, 'team', 'workday', input),
					terminalizeCapacityWorkdayAssignments(f.owner, 'team', 'workday', input)]);
				for (const result of denied) {
					expect(result.status).toBe('rejected');
					if (result.status === 'rejected') expect(result.reason)
						.toMatchObject({ code: 'provider_assignment_usage_required', status: 409 });
				}
				expect(await f.snapshot()).toEqual(before); expect(input).toEqual(held);
				expect((await f.query('SELECT state,settlement_token FROM capacity_reservations')).rows)
					.toEqual([{ state: 'reserved', settlement_token: null }]);
				expect((await f.query('SELECT counter_id,released_amount FROM capacity_reservation_counter_claims ORDER BY counter_id')).rows)
					.toEqual([{ counter_id: 'concurrency', released_amount: 0 }, { counter_id: 'seconds', released_amount: 0 }]);
				expect((await f.query('SELECT COUNT(*) AS total FROM capacity_usage_actuals')).rows).toEqual([{ total: 0 }]);
				expect((await f.query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 0 }]);
				await expect(terminalizeCapacityWorkdayAssignments(f.owner, 'team', 'workday', input))
					.rejects.toMatchObject({ code: 'provider_assignment_usage_required', status: 409 });
				expect(await f.snapshot()).toEqual(before);
			} finally { await f.db.close(); }
		}
	});
	it('native workday stop advances canonical terminal metadata without changing admitted authority or replaying settlement', async () => {
		for (const started of [false, true]) {
			const native = await cancellationDatabase('returned', started);
			try {
				clock();
				if (started) await settleCapacityReservationExactlyOnce(native.owner, terminalUsage);
				const repository = new ProviderAssignmentRepository(native.owner), before = await repository.get('team', native.assignment.id);
				if (!before?.assignmentAttempt) throw new Error('Missing original full canonical attempt');
				await terminalizeCapacityWorkdayAssignments(native.owner, 'team', 'workday', { now: cancelNow });
				const after = await repository.get('team', before.id);
				expect(after?.status).toBe('failed');
				expect(after?.assignmentAttempt).toEqual({ ...before.assignmentAttempt, status: 'failed', finishedAt: cancelNow });
				expect(after?.attemptCount).toBe(before.attemptCount);
				const terminal = await native.snapshot();
				await terminalizeCapacityWorkdayAssignments(native.owner, 'team', 'workday', { now: '2026-10-02T21:00:05.000Z' });
				expect(await native.snapshot()).toEqual(terminal);
				expect((await native.query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 1 }]);
			} finally { await native.db.close(); }
		}
	});
	it('preserves an unexpired provider lease while cancelling only unclaimed nodes in its workday', async () => {
		const { db, owner, query, snapshot, attempt } = await cancellationDatabase();
		try {
			clock(); const now = '2026-10-02T21:00:01.000Z';
			await query(`INSERT INTO execution_nodes (id,team_id,project_id,workday_id,kind,source_ref_json,rule_revision,node_revision,
				agent_class,status,graph_revision_created,graph_revision_updated,created_at,updated_at)
				SELECT 'unclaimed',team_id,project_id,workday_id,kind,source_ref_json,
				rule_revision,node_revision,agent_class,'ready',graph_revision_created,graph_revision_updated,created_at,updated_at
				FROM execution_nodes WHERE id='report-node'`);
			const before = await snapshot(), input = { now, preserveActiveLeasesUntil: attempt.deadline }, copy = structuredClone(input);
			const result = await terminalizeCapacityWorkdayAssignments(owner, 'team', 'workday', input);
			expect(result).toMatchObject({ assignmentCount: 1, unfinishedAssignmentCount: 1, deferredActiveAssignmentCount: 1,
				settlementErrorCount: 0 });
			expect(await snapshot()).toEqual(before); expect(input).toEqual(copy);
			expect((await query('SELECT id,status FROM execution_nodes ORDER BY id')).rows)
				.toEqual([{ id: 'report-node', status: 'running' }, { id: 'unclaimed', status: 'cancelled' }]);
			await terminalizeCapacityWorkdayAssignments(owner, 'foreign-team', 'workday', input);
			expect(await snapshot()).toEqual(before);
		} finally { await db.close(); }
	});
	it('refuses unknown productive usage at the workday boundary instead of writing zero and declaring closure', async () => {
		const { db, owner, query, snapshot } = await cancellationDatabase('returned', true);
		try {
			clock(); const before = await snapshot(); let denied = false, failure: unknown;
			try { await terminalizeCapacityWorkdayAssignments(owner, 'team', 'workday', { now: cancelNow }); }
			catch (error) { denied = true; failure = error; }
			expect(failure).toMatchObject({ code: 'provider_assignment_usage_required', status: 409 });
			expect({ denied, usage: (await query('SELECT active_seconds,elapsed_seconds FROM capacity_usage_actuals')).rows,
				ledger: (await query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows })
				.toEqual({ denied: true, usage: [], ledger: [{ total: 0 }] });
			expect(await snapshot()).toEqual(before);
		} finally { await db.close(); }
	});
	it('preserves measured settlement and immutable attempts through repeated terminal cleanup', async () => {
		const { db, owner, query, snapshot, assignment } = await cancellationDatabase('returned', true);
		try {
			clock(); await settleCapacityReservationExactlyOnce(owner, terminalUsage);
			const result = await terminalizeCapacityWorkdayAssignments(owner, 'team', 'workday', { now: cancelNow });
			expect(result).toMatchObject({ failedAssignments: 1, unfinishedAssignmentCount: 0, deferredActiveAssignmentCount: 0 });
			const before = await snapshot();
			await terminalizeCapacityWorkdayAssignments(owner, 'team', 'workday', { now: cancelNow });
			expect(await snapshot()).toEqual(before);
			expect((await query('SELECT assignment_attempt_json,attempt_count,lease_token,lease_state,lease_expires_at,lease_renewed_at,runner_id FROM capacity_provider_assignments')).rows)
				.toEqual([{ assignment_attempt_json: JSON.stringify({ ...assignment.assignmentAttempt,
					status: 'failed', finishedAt: cancelNow }), attempt_count: 1, lease_token: null,
					lease_state: 'released', lease_expires_at: null, lease_renewed_at: null, runner_id: null }]);
			expect((await query('SELECT active_seconds,elapsed_seconds FROM capacity_usage_actuals')).rows).toEqual([{ active_seconds: 2, elapsed_seconds: 3 }]);
			expect((await query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 1 }]);
			expect((await query("SELECT committed_amount FROM capacity_admission_counters WHERE id='concurrency'")).rows).toEqual([{ committed_amount: 0 }]);
		} finally { await db.close(); }
	});
	it('retains already durable measurements across a real transition SQL interruption and retry', async () => {
		const { db, owner, query, snapshot } = await cancellationDatabase('returned', true);
		try {
			clock(); await settleCapacityReservationExactlyOnce(owner, terminalUsage); const before = await snapshot();
			await db.exec(`CREATE FUNCTION deny_terminal_transition() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN RAISE EXCEPTION 'isolated terminal transition interruption'; END; $$;
				CREATE TRIGGER deny_terminal_transition BEFORE UPDATE ON capacity_provider_assignments
				FOR EACH ROW WHEN (NEW.status='failed') EXECUTE FUNCTION deny_terminal_transition();`);
			await expect(terminalizeCapacityWorkdayAssignments(owner, 'team', 'workday', { now: cancelNow }))
				.rejects.toThrow('isolated terminal transition interruption');
			expect(await snapshot()).toEqual(before);
			await db.exec('DROP TRIGGER deny_terminal_transition ON capacity_provider_assignments');
			await terminalizeCapacityWorkdayAssignments(owner, 'team', 'workday', { now: cancelNow });
			expect((await query('SELECT active_seconds,elapsed_seconds FROM capacity_usage_actuals')).rows).toEqual([{ active_seconds: 2, elapsed_seconds: 3 }]);
			expect((await query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 1 }]);
		} finally { await db.close(); }
	});
	it('does not report complete cleanup while an orphan running graph node remains', async () => {
		const { db, owner, query } = await cancellationDatabase('returned', true);
		try {
			clock(); await settleCapacityReservationExactlyOnce(owner, terminalUsage);
			// Explicit corrupt persisted input, not evidence that real admission creates orphans.
			await query('DELETE FROM capacity_provider_assignments');
			const result = await terminalizeCapacityWorkdayAssignments(owner, 'team', 'workday', { now: cancelNow });
			expect(result).toMatchObject({ assignmentCount: 0, unfinishedAssignmentCount: 1, settlementErrorCount: 0 });
			const remaining = (await query("SELECT id FROM execution_nodes WHERE status='running'")).rows;
			expect({ closureBlocked: result.unfinishedAssignmentCount > 0, remaining }).toEqual({ closureBlocked: true, remaining: [{ id: 'report-node' }] });
		} finally { await db.close(); }
	});
});
