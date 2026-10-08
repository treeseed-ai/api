import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperatorAssignmentService } from '../../../../../../src/api/capacity/services/capacity/assignments/observability/operator-assignment-service.ts';
import { settleCapacityReservationExactlyOnce } from '../../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts';
import { terminalUsage } from '../../../capacity/accounting/architecture/settlement-fixture.ts';
import { cancellationDatabase, cancelNow } from './cancellation-fixture.ts';
import { ProviderAssignmentRepository } from '../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import { validateProviderAssignment } from '@treeseed/sdk/agent-capacity';

afterEach(() => vi.useRealTimers());
function atNow() { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(cancelNow)); }
// REAL owning cancellation/repository/accounting + original DDL/PGlite.
// No authenticated HTTP, provider-generated clocks/usage, physical teardown,
// or separate PostgreSQL connection concurrency is claimed.
describe('cancellation retains productive and financial authority through original SQL', () => {
	it('native operator cancellation advances only canonical terminal metadata and retains exact failed history on replay', async () => {
		const native = await cancellationDatabase('returned', true);
		try {
			atNow(); await settleCapacityReservationExactlyOnce(native.owner, terminalUsage);
			const before = await new ProviderAssignmentRepository(native.owner).get('team', native.assignment.id);
			if (!before?.assignmentAttempt) throw new Error('Missing original canonical attempt');
			const service = new OperatorAssignmentService(native.owner), input = { idempotencyKey: 'canonical-cancellation' };
			const original = structuredClone(input), result = await service.cancel('team', before.id, input);
			expect(result.assignmentAttempt).toEqual({ ...before.assignmentAttempt, status: 'cancelled', finishedAt: cancelNow });
			expect(result.attemptCount).toBe(before.attemptCount);
			const terminal = await native.snapshot();
			await service.cancel('team', before.id, input);
			expect(await native.snapshot()).toEqual(terminal); expect(input).toEqual(original);
			expect((await native.query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 1 }]);
		} finally { await native.db.close(); }
	});
	it('requests active lease cancellation without terminalizing releasing or rewriting its immutable attempt', async () => {
		const { db, owner, query, assignment, attempt, snapshot } = await cancellationDatabase();
		try {
			atNow(); const before = structuredClone(attempt);
			const result = await new OperatorAssignmentService(owner).cancel('team', assignment.id, { idempotencyKey: 'cancel-request' });
			expect(result).toMatchObject({ status: 'leased', leaseState: 'leased', leaseToken: 'lease-token',
				metadata: { cancellationRequested: true }, lifecycleCode: 'operator_cancellation_requested' });
			expect(result.assignmentAttempt).toEqual(before); expect(result.attemptCount).toBe(1);
			expect((await query('SELECT state,active_seconds,elapsed_seconds FROM capacity_reservations')).rows)
				.toEqual([{ state: 'consuming', active_seconds: 0, elapsed_seconds: 0 }]);
			expect((await query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 0 }]);
			expect((await query('SELECT COUNT(*) AS total FROM capacity_usage_actuals')).rows).toEqual([{ total: 0 }]);
			expect(attempt).toEqual(before);
			const repository = new ProviderAssignmentRepository(owner);
			for (const bytes of ['{}', 'not-json', JSON.stringify({ ...attempt, teamId: 'foreign-team' })]) {
				await query('UPDATE capacity_provider_assignments SET assignment_attempt_json=? WHERE id=?', [bytes, attempt.id]);
				const retained = await snapshot();
				await expect(repository.get('team', attempt.id)).rejects.toMatchObject({ code: expect.stringMatching(/provider_assignment_(contract|json)_invalid/u) });
				const diagnostic = await repository.getForCancellation('team', attempt.id);
				expect(diagnostic).toMatchObject({ id: attempt.id,
					assignmentAttempt: null, assignmentResult: null, explanation: { snapshotValidation: { valid: false } } });
				expect(validateProviderAssignment(diagnostic).ok).toBe(false);
				expect(await repository.getForCancellation('foreign-team', attempt.id)).toBeNull();
				expect(await snapshot()).toEqual(retained);
			}
		} finally { await db.close(); }
	});
	it('replays terminal cancellation without replacing measured settlement or releasing counters twice', async () => {
		const { db, owner, query, assignment, snapshot } = await cancellationDatabase('returned', true);
		try {
			atNow(); await settleCapacityReservationExactlyOnce(owner, terminalUsage);
			const service = new OperatorAssignmentService(owner), first = await service.cancel('team', assignment.id, { idempotencyKey: 'cancel-terminal' });
			const before = await snapshot(); const repeated = await service.cancel('team', assignment.id, { idempotencyKey: 'cancel-terminal' });
			expect(first.status).toBe('cancelled'); expect(repeated.assignmentAttempt).toEqual(first.assignmentAttempt);
			expect(await snapshot()).toEqual(before);
			expect((await query('SELECT active_seconds,elapsed_seconds FROM capacity_usage_actuals')).rows).toEqual([{ active_seconds: 2, elapsed_seconds: 3 }]);
			expect((await query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 1 }]);
			expect((await query("SELECT committed_amount FROM capacity_admission_counters WHERE id='concurrency'")).rows).toEqual([{ committed_amount: 0 }]);
		} finally { await db.close(); }
	});
	it('refuses unknown productive usage instead of fabricating a zero settlement during terminal cancellation', async () => {
		const { db, owner, query, assignment, snapshot } = await cancellationDatabase('returned', true);
		try {
			atNow(); const retained = await snapshot(); let denied = false;
			try { await new OperatorAssignmentService(owner).cancel('team', assignment.id, { idempotencyKey: 'cancel-unknown-usage' }); }
			catch { denied = true; }
			expect({ denied, measurements: (await query('SELECT active_seconds,elapsed_seconds FROM capacity_usage_actuals')).rows,
				settlements: (await query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows })
				.toEqual({ denied: true, measurements: [], settlements: [{ total: 0 }] });
			expect(await snapshot()).toEqual(retained);
		} finally { await db.close(); }
	});
	it('retains durable measured settlement when workspace cleanup is interrupted and retried', async () => {
		const { db, owner, query, assignment } = await cancellationDatabase('returned', true);
		try {
			atNow(); await settleCapacityReservationExactlyOnce(owner, terminalUsage);
			await expect(new OperatorAssignmentService(owner, async () => { throw new Error('isolated cleanup interruption'); })
				.cancel('team', assignment.id, { idempotencyKey: 'cancel-cleanup' })).rejects.toThrow('isolated cleanup interruption');
			const result = await new OperatorAssignmentService(owner).cancel('team', assignment.id, { idempotencyKey: 'cancel-cleanup' });
			expect(result.status).toBe('cancelled'); expect(result.attemptCount).toBe(1);
			expect((await query('SELECT active_seconds,elapsed_seconds FROM capacity_usage_actuals')).rows).toEqual([{ active_seconds: 2, elapsed_seconds: 3 }]);
			expect((await query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 1 }]);
		} finally { await db.close(); }
	});
	it('denies foreign team missing idempotency and completed assignment cancellation without accounting mutation', async () => {
		const { db, owner, assignment, snapshot } = await cancellationDatabase('completed');
		try {
			atNow(); const before = await snapshot(), service = new OperatorAssignmentService(owner);
			await expect(service.cancel('foreign-team', assignment.id, { idempotencyKey: 'cancel' })).rejects.toMatchObject({ status: 404 });
			await expect(service.cancel('team', assignment.id, { idempotencyKey: '' })).rejects.toMatchObject({ status: 400 });
			await expect(service.cancel('team', assignment.id, { idempotencyKey: 'cancel' })).rejects.toMatchObject({ status: 409 });
			expect(await snapshot()).toEqual(before);
		} finally { await db.close(); }
	});
});
