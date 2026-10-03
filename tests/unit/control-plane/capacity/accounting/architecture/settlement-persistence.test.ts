import { describe, expect, it } from 'vitest';
import { settleCapacityReservationExactlyOnce } from '../../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts';
import type { CapacitySettlementRequest } from '../../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts';
import { frozenAttempt, settlementDatabase, terminalUsage } from './settlement-fixture.ts';

// REAL owning settlement service and original transactional SQL/unique guards.
// Supplied terminal measurements are NOT provider-generated usage/live teardown;
// concurrent PGlite requests are NOT independent PostgreSQL connection proof.
describe('terminal accounting through the owning transaction and persistence', () => {
	it('settles repeated and concurrent matching terminal reports once with exact native usage and immutable authority', async () => {
		const { db, owner, query, snapshot } = await settlementDatabase();
		try {
			const before = structuredClone(terminalUsage);
			const results = await Promise.all([settleCapacityReservationExactlyOnce(owner, terminalUsage),
				settleCapacityReservationExactlyOnce(owner, terminalUsage)]);
			expect(results.filter(value => !value.replayed)).toHaveLength(1);
			expect((await settleCapacityReservationExactlyOnce(owner, terminalUsage)).replayed).toBe(true);
			const usage = (await query('SELECT * FROM capacity_usage_actuals')).rows;
			expect(usage).toHaveLength(1); expect(usage[0]).toMatchObject({ assignment_id: frozenAttempt.id, assignment_attempt: 1,
				project_id: frozenAttempt.projectId, work_day_id: frozenAttempt.workdayId, accounting_mode: 'aggregate', active_seconds: 2, elapsed_seconds: 3,
				task_signature: 'configured-builder:acting', execution_provider_id: frozenAttempt.provider.executionProviderId });
			expect(JSON.parse(String(usage[0]!.native_usage_json))).toEqual(terminalUsage.usageActual!.nativeUsage);
			expect((await query('SELECT * FROM capacity_ledger_entries')).rows).toHaveLength(1);
			expect((await query('SELECT state,active_seconds,elapsed_seconds FROM capacity_reservations')).rows)
				.toEqual([{ state: 'consumed', active_seconds: 2, elapsed_seconds: 3 }]);
			expect((await query('SELECT id,hard_limit,committed_amount FROM capacity_admission_counters ORDER BY id')).rows)
				.toEqual([{ id: 'concurrency', hard_limit: 1, committed_amount: 0 }, { id: 'seconds', hard_limit: 3, committed_amount: 2 }]);
			expect((await query('SELECT assignment_attempt_json FROM capacity_provider_assignments')).rows[0]!.assignment_attempt_json)
				.toBe(JSON.stringify(frozenAttempt));
			const stable = await snapshot(); await settleCapacityReservationExactlyOnce(owner, terminalUsage);
			expect(await snapshot()).toEqual(stable); expect(terminalUsage).toEqual(before);
		} finally { await db.close(); }
	});
	it('denies foreign identity changed attempt and conflicting scalar retries without altering any durable accounting row', async () => {
		const { db, owner, snapshot } = await settlementDatabase();
		try {
			await settleCapacityReservationExactlyOnce(owner, terminalUsage); const before = await snapshot();
			const changes = [{ teamId: 'foreign-team' }, { membershipId: 'foreign-membership' }, { assignmentId: 'foreign-assignment' },
				{ reservationId: 'foreign-reservation' }, { assignmentAttempt: 2 }, { activeSeconds: 3 }, { elapsedSeconds: 4 }];
			for (const change of changes) await expect(settleCapacityReservationExactlyOnce(owner, { ...terminalUsage, ...change })).rejects.toThrow();
			expect(await snapshot()).toEqual(before);
		} finally { await db.close(); }
	});
	it('rejects changed native usage and provider model replay instead of silently retaining incompatible measured authority', async () => {
		const { db, owner, snapshot } = await settlementDatabase();
		try {
			await settleCapacityReservationExactlyOnce(owner, terminalUsage); const before = await snapshot();
			const changes = [{ nativeUsage: { activeSeconds: 2, tokens: 8 } }, { executionProviderId: 'foreign-provider' }, { modelName: 'foreign-model' }];
			const outcomes: string[] = [];
			for (const change of changes) {
				try { await settleCapacityReservationExactlyOnce(owner, { ...terminalUsage, usageActual: { ...terminalUsage.usageActual, ...change } }); outcomes.push('ADMITTED'); }
				catch { outcomes.push('DENIED'); }
			}
			expect(await snapshot()).toEqual(before); expect(outcomes).toEqual(changes.map(() => 'DENIED'));
		} finally { await db.close(); }
	});
	it('rolls back real late SQL failure including usage counters and claim then permits one clean retry', async () => {
		const { db, owner, snapshot } = await settlementDatabase();
		try {
			await db.exec(`CREATE FUNCTION isolated_settlement_fault() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN RAISE EXCEPTION 'isolated late settlement failure'; END; $$;
				CREATE TRIGGER isolated_settlement_fault BEFORE INSERT ON capacity_ledger_entries
				FOR EACH ROW EXECUTE FUNCTION isolated_settlement_fault();`);
			const before = await snapshot();
			await expect(settleCapacityReservationExactlyOnce(owner, terminalUsage)).rejects.toThrow(/isolated late settlement failure/u);
			expect(await snapshot()).toEqual(before);
			await db.exec('DROP TRIGGER isolated_settlement_fault ON capacity_ledger_entries; DROP FUNCTION isolated_settlement_fault();');
			expect((await settleCapacityReservationExactlyOnce(owner, terminalUsage)).replayed).toBe(false);
			expect((await settleCapacityReservationExactlyOnce(owner, terminalUsage)).replayed).toBe(true);
		} finally { await db.close(); }
	});
	it('records supplied terminal overrun truth without raising hard limits or charging a replay twice', async () => {
		const { db, owner, query, snapshot } = await settlementDatabase();
		try {
			// A measured overrun input is not permission for execution beyond its original deadline.
			const overrun = { ...terminalUsage, activeSeconds: 4, elapsedSeconds: 4,
				usageActual: { ...terminalUsage.usageActual, nativeUsage: { activeSeconds: 4, tokens: 7 } } };
			await settleCapacityReservationExactlyOnce(owner, overrun);
			expect((await query("SELECT hard_limit,committed_amount FROM capacity_admission_counters WHERE id='seconds'")).rows)
				.toEqual([{ hard_limit: 3, committed_amount: 4 }]);
			expect((await query('SELECT active_seconds,released_seconds,overrun_seconds FROM capacity_reservations')).rows)
				.toEqual([{ active_seconds: 4, released_seconds: 0, overrun_seconds: 2 }]);
			const before = await snapshot(); await settleCapacityReservationExactlyOnce(owner, overrun); expect(await snapshot()).toEqual(before);
		} finally { await db.close(); }
	});
	it('denies incomplete frozen attempt instead of committing unattributed terminal measurements', async () => {
		const { db, owner, query, snapshot } = await settlementDatabase();
		try {
			await query('UPDATE capacity_provider_assignments SET assignment_attempt_json=?', ['{}']);
			const before = await snapshot(); let denied = false;
			try { await settleCapacityReservationExactlyOnce(owner, terminalUsage); } catch { denied = true; }
			expect({ denied, unchanged: JSON.stringify(await snapshot()) === JSON.stringify(before) }).toEqual({ denied: true, unchanged: true });
		} finally { await db.close(); }
	});
	it('denies coerced attempt identity before charging a reservation through actual SQL', async () => {
		const { db, owner, snapshot } = await settlementDatabase();
		try {
			const before = await snapshot(); let denied = false;
			try { await settleCapacityReservationExactlyOnce(owner, { ...terminalUsage, assignmentAttempt: '1' } as unknown as CapacitySettlementRequest); }
			catch { denied = true; }
			expect({ denied, unchanged: JSON.stringify(await snapshot()) === JSON.stringify(before) }).toEqual({ denied: true, unchanged: true });
		} finally { await db.close(); }
	});
	it('denies corrupt native units rather than durably writing negative coerced or null measurements', async () => {
		const invalid = [{ tokens: -1 }, { tokens: Infinity }, { tokens: NaN }, { tokens: '7' }, { tokens: null }];
		const outcomes: Array<{ denied: boolean; unchanged: boolean }> = [];
		for (const nativeUsage of invalid) {
			const { db, owner, snapshot } = await settlementDatabase();
			try {
				const before = await snapshot(); let denied = false;
				try { await settleCapacityReservationExactlyOnce(owner, { ...terminalUsage, usageActual: { ...terminalUsage.usageActual, nativeUsage } }); }
				catch { denied = true; }
				outcomes.push({ denied, unchanged: JSON.stringify(await snapshot()) === JSON.stringify(before) });
			} finally { await db.close(); }
		}
		expect(outcomes).toEqual(invalid.map(() => ({ denied: true, unchanged: true })));
	});
});
