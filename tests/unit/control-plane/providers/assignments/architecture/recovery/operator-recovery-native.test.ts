import { describe, expect, it } from 'vitest';
import { executePostgresBatch } from '../../../../../../../src/api/support/control-plane-postgres.ts';
import { OperatorAssignmentService } from '../../../../../../../src/api/capacity/services/capacity/assignments/observability/operator-assignment-service.ts';
import { createAssignmentService } from '../../../../../../../src/api/control-plane/repositories/capacity/assignment-service.ts';
import { cancellationDatabase } from '../cancellation-fixture.ts';
import { terminalUsage } from '../../../../capacity/accounting/architecture/settlement-fixture.ts';
import { settleCapacityReservationExactlyOnce } from '../../../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts';
import { createProviderAssignmentService } from '../../../../../../../src/api/control-plane/repositories/providers/provider-assignment-service.ts';
import { ProviderAssignmentRepository } from '../../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';

async function nativeRecovery() {
	const f = await cancellationDatabase('expired');
	const owner = Object.assign(f.owner, { db: { transaction: async <T>(run: (client: Parameters<typeof executePostgresBatch>[0]) => Promise<T>) =>
		f.db.transaction(transaction => run(transaction as unknown as Parameters<typeof executePostgresBatch>[0])) } });
	await f.query(`UPDATE capacity_provider_assignments SET lease_state='expired',lifecycle_code='expired_lease_execution_usage_unknown',
		lifecycle_output_json=?,metadata_json=? WHERE id=?`, [JSON.stringify({ report: 'retained-native-candidate', usage: { elapsedSeconds: 1 } }),
		JSON.stringify({ leaseRecovery: { disposition: 'operator-action' } }), f.assignment.id]);
	const operator = new OperatorAssignmentService(owner);
	const service = createAssignmentService({ recoverCapacityAssignment: (team: string, id: string, input: Record<string, unknown>) => operator.recover(team, id, input) });
	const call = (input: Record<string, unknown> = { expectedStateVersion: 1, reason: 'Active measurement unavailable' }, key = 'native-recovery', team = 'team', id = f.assignment.id) =>
		service.recover({ id: 'operator', roles: ['admin'] }, team, id, input, key);
	const snapshot = async () => ({ ...await f.snapshot(), audit: (await f.query('SELECT * FROM capacity_audit_events ORDER BY id')).rows });
	return { ...f, owner, call, snapshot };
}

// Real owning public service + transaction/row locks/original PostgreSQL DDL.
// PGlite overlap is not separate-server concurrency, native provider charges,
// authenticated HTTP or physical sandbox/workspace closure proof.
describe('native unresolved operator recovery', () => {
	it('native operator recovery releases only terminal capacity once and retains unresolved usage report and expired authority without a settlement', async () => {
		const f = await nativeRecovery(); try {
			const before = await f.snapshot(), first = await f.call();
			expect(first).toMatchObject({ assignmentId: f.assignment.id, reservationId: 'reservation', usageStatus: 'unresolved', settled: false });
			const after = await f.snapshot();
			expect(after.capacity_provider_assignments).toEqual(before.capacity_provider_assignments);
			expect(after.capacity_usage_actuals).toEqual([]); expect(after.capacity_ledger_entries).toEqual([]);
			expect(after.audit).toHaveLength(1);
			expect(JSON.parse(String(after.audit[0]!.metadata_json))).toMatchObject({ usageStatus: 'unresolved', settled: false,
				expectedStateVersion: 1, actorId: 'operator', reason: 'Active measurement unavailable' });
			expect((await f.query('SELECT state,active_seconds,elapsed_seconds,settlement_token FROM capacity_reservations')).rows)
				.toEqual([{ state: 'released', active_seconds: 0, elapsed_seconds: 0, settlement_token: null }]);
			expect((await f.query('SELECT id,committed_amount FROM capacity_admission_counters ORDER BY id')).rows)
				.toEqual([{ id: 'concurrency', committed_amount: 0 }, { id: 'seconds', committed_amount: 2 }]);
			expect((await f.query('SELECT counter_id,released_amount FROM capacity_reservation_counter_claims ORDER BY counter_id')).rows)
				.toEqual([{ counter_id: 'concurrency', released_amount: 1 }, { counter_id: 'seconds', released_amount: 0 }]);
			expect(await f.call()).toEqual(first); expect(await f.snapshot()).toEqual(after);
			const unused = async () => { throw new Error('Recovery read must not invoke a productive lifecycle'); };
			const provider = createProviderAssignmentService({ ...f.owner,
				getProviderAssignment: (team, id) => new ProviderAssignmentRepository(f.owner).get(team, id),
				leaseNextProviderAssignment: unused, renewProviderAssignmentLease: unused, returnProviderAssignment: unused,
				completeProviderAssignment: unused, failProviderAssignment: unused,
				createCapacityWorkdayRun: unused, tickCapacityWorkdayRun: unused, updateCapacityWorkdayRun: unused });
			const principal = { principal: { teamId: f.assignment.teamId, capacityProviderId: f.assignment.capacityProviderId,
				membershipId: f.assignment.membershipId!, scopes: ['provider:assignments:read'] } };
			expect(await provider.show(principal, f.assignment.id)).toEqual({
				...await new ProviderAssignmentRepository(f.owner).get('team', f.assignment.id), unresolvedUsageRecovery: first });
			await expect(provider.show({ principal: { ...principal.principal, capacityProviderId: 'foreign' } }, f.assignment.id))
				.rejects.toMatchObject({ status: 403 });
			expect(await f.snapshot()).toEqual(after);
			await expect(f.call({ expectedStateVersion: 1, reason: 'Changed evidence' })).rejects.toMatchObject({ status: 409 });
			await expect(f.call(undefined, 'other-key')).rejects.toMatchObject({ status: 409 });
			expect(await f.snapshot()).toEqual(after);
		} finally { await f.db.close(); }
	});
	it('native recovery denies active foreign stale measured and mismatched reservation authority without changing retained history', async () => {
		const f = await nativeRecovery(); try {
			const baseline = await f.snapshot();
			for (const [team, id, input, key] of [
				['foreign', f.assignment.id, { expectedStateVersion: 1, reason: 'Unknown' }, 'foreign'],
				['team', 'missing', { expectedStateVersion: 1, reason: 'Unknown' }, 'missing'],
				['team', f.assignment.id, { expectedStateVersion: 2, reason: 'Unknown' }, 'stale'],
				['team', f.assignment.id, { expectedStateVersion: 1, reason: 'Unknown' }, ''],
			] as const) { await expect(f.call(input, key, team, id)).rejects.toBeInstanceOf(Error); expect(await f.snapshot()).toEqual(baseline); }
			for (const status of ['pending', 'leased', 'running', 'completed', 'returned']) {
				await f.query('UPDATE capacity_provider_assignments SET status=? WHERE id=?', [status, f.assignment.id]);
				const retained = await f.snapshot(); await expect(f.call()).rejects.toMatchObject({ status: 409 }); expect(await f.snapshot()).toEqual(retained);
			}
			await f.query("UPDATE capacity_provider_assignments SET status='expired' WHERE id=?", [f.assignment.id]);
			await f.query("UPDATE capacity_reservations SET assignment_id='foreign' WHERE id='reservation'");
			const foreign = await f.snapshot(); await expect(f.call()).rejects.toMatchObject({ status: 409 }); expect(await f.snapshot()).toEqual(foreign);
			await f.query("UPDATE capacity_reservations SET assignment_id=? WHERE id='reservation'", [f.assignment.id]);
			const originalExecutor = f.attempt.provider.executionProviderId;
			await f.query("UPDATE capacity_reservations SET execution_provider_id='foreign' WHERE id='reservation'");
			const movedExecutor = await f.snapshot(); let executorDenial: unknown;
			try { await f.call(); } catch (error) { executorDenial = error; }
			const executorAfter = await f.snapshot();
			await f.query("UPDATE capacity_reservations SET execution_provider_id=? WHERE id='reservation'", [originalExecutor]);
			expect(executorDenial).toMatchObject({ status: 409 }); expect(executorAfter).toEqual(movedExecutor);
			await settleCapacityReservationExactlyOnce(f.owner, terminalUsage);
			const measured = await f.snapshot(); await expect(f.call()).rejects.toMatchObject({ status: 409 }); expect(await f.snapshot()).toEqual(measured);
		} finally { await f.db.close(); }
	});
	it('native unresolved recovery refuses an orphan counter claim rather than silently releasing an unaccounted reservation', async () => {
		const f = await nativeRecovery(); try {
			await f.query("DELETE FROM capacity_admission_counters WHERE id='concurrency'");
			const before = await f.snapshot();
			await expect(f.call()).rejects.toMatchObject({ status: 409, code: 'capacity_recovery_counter_conflict' });
			expect(await f.snapshot()).toEqual(before);
		} finally { await f.db.close(); }
	});
	it('native overlapping recoveries produce one retained audit and one terminal counter release without rewriting usage', async () => {
		const f = await nativeRecovery(); try {
			const results = await Promise.all([f.call(), f.call()]); expect(results[0]).toEqual(results[1]);
			const held = await f.snapshot(); expect(held.audit).toHaveLength(1);
			expect(held.capacity_usage_actuals).toEqual([]); expect(held.capacity_ledger_entries).toEqual([]);
			expect(await f.call()).toEqual(results[0]); expect(await f.snapshot()).toEqual(held);
		} finally { await f.db.close(); }
	});
	it('native late audit interruption rolls back capacity release and exact retry preserves the original failed output', async () => {
		const f = await nativeRecovery(); try {
			await f.db.exec(`CREATE FUNCTION interrupt_recovery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'retained native recovery interruption'; END $$;
				CREATE TRIGGER interrupt_recovery BEFORE INSERT ON capacity_audit_events FOR EACH ROW EXECUTE FUNCTION interrupt_recovery();`);
			const before = await f.snapshot(); await expect(f.call()).rejects.toThrow('retained native recovery interruption');
			expect(await f.snapshot()).toEqual(before);
			await f.db.exec('DROP TRIGGER interrupt_recovery ON capacity_audit_events');
			expect(await f.call()).toMatchObject({ usageStatus: 'unresolved', settled: false });
			expect((await f.snapshot()).capacity_provider_assignments).toEqual(before.capacity_provider_assignments);
		} finally { await f.db.close(); }
	});
});
