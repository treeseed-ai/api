import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancellationDatabase, cancelNow } from '../../../../providers/assignments/architecture/cancellation-fixture.ts';
import { terminalUsage } from '../../../accounting/architecture/settlement-fixture.ts';
import { settleCapacityReservationExactlyOnce } from '../../../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts';
import { terminalizeCapacityWorkdayAssignments } from '../../../../../../../src/api/capacity/services/capacity/workdays/lifecycle/workday-assignment-terminalization-service.ts';
import { maintainCapacityWorkdayRuns } from '../../../../../../../src/api/capacity/services/capacity/workdays/lifecycle/workday-recovery-service.ts';
import { CapacityWorkdayEventService } from '../../../../../../../src/api/capacity/services/capacity/workdays/content/workday-event-service.ts';
import { CapacityWorkdayRunWriteRepository } from '../../../../../../../src/api/capacity/repositories/capacity/workdays/workday-run-write.ts';
import { splitPostgresSqlStatements } from '../../../../../../../src/api/persistence/postgres-sql-statements.ts';

afterEach(() => vi.useRealTimers());
async function fixture() {
	const base = await cancellationDatabase('returned', true);
	try {
		const original = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'));
		for (const prefix of ['CREATE TABLE "capacity_workday_events" (', 'CREATE UNIQUE INDEX "idx_capacity_workday_events_run_index"']) {
			const statements = original.filter(sql => sql.startsWith(prefix));
			if (statements.length !== 1) throw new Error(`Missing original event authority ${prefix}`);
			await base.db.exec(statements[0]!);
		}
		const events = new CapacityWorkdayEventService(base.owner);
		return { ...base, recovery: { ...base.owner,
			terminalizeCapacityWorkdayAssignments: (team: string, run: string, input: Record<string, unknown>) =>
				terminalizeCapacityWorkdayAssignments(base.owner, team, run, input),
			createCapacityWorkdayEvent: events.create.bind(events) } };
	} catch (error) { await base.db.close(); throw error; }
}
// REAL lifecycle/repository/accounting/event SQL. Supplied records are isolated
// inputs, not provider usage, authenticated HTTP or physical sandbox closure.
describe('native workday recovery keeps failed history without blocking other runs', () => {
	it('does not execute deadline recovery before the original authority deadline or mutate scoped rows', async () => {
		const { db, query, snapshot, recovery } = await fixture();
		try {
			const before = await snapshot(), runs = await query('SELECT * FROM capacity_workday_runs');
			expect(await maintainCapacityWorkdayRuns(recovery, 'team', '2026-10-02T21:00:01.000Z'))
				.toEqual({ expired: 0, recoveredTerminalRuns: 0 });
			expect(await snapshot()).toEqual(before); expect(await query('SELECT * FROM capacity_workday_runs')).toEqual(runs);
			expect((await query('SELECT * FROM capacity_workday_events')).rows).toEqual([]);
			expect(await maintainCapacityWorkdayRuns(recovery, 'foreign-team', cancelNow)).toEqual({ expired: 0, recoveredTerminalRuns: 0 });
			expect(await snapshot()).toEqual(before);
		} finally { await db.close(); }
	});
	it('reports corrupt old-run provenance while closing another settled run and preserves both outcomes on retry', async () => {
		const { db, query, owner, reads, recovery } = await fixture();
		try {
			vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(cancelNow));
			await settleCapacityReservationExactlyOnce(owner, terminalUsage);
			const current = (await reads.get('team', 'workday'))!;
			const writes = new CapacityWorkdayRunWriteRepository(owner);
			await writes.update({ ...current, status: 'cancelled', completedAt: cancelNow }, current.status);
			await writes.create({ ...current, id: 'a-old-workday', status: 'cancelled', completedAt: cancelNow });
			const originalRow = (await query('SELECT * FROM capacity_provider_assignments')).rows[0]!;
			const oldRow = { ...originalRow, id: 'old-invalid-assignment', work_day_id: 'a-old-workday', reservation_id: null };
			const columns = Object.keys(oldRow);
			await query(`INSERT INTO capacity_provider_assignments (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, Object.values(oldRow));
			const oldBefore = (await query("SELECT * FROM capacity_provider_assignments WHERE id='old-invalid-assignment'")).rows;
			await expect(maintainCapacityWorkdayRuns(recovery, 'team', cancelNow)).rejects.toThrow(/Terminal workday a-old-workday.*reservation and membership/u);
			expect((await query("SELECT status,lease_token,attempt_count FROM capacity_provider_assignments WHERE id='assignment-report'")).rows)
				.toEqual([{ status: 'failed', lease_token: null, attempt_count: 1 }]);
			expect((await query("SELECT * FROM capacity_provider_assignments WHERE id='old-invalid-assignment'")).rows).toEqual(oldBefore);
			expect((await query('SELECT active_seconds,elapsed_seconds FROM capacity_usage_actuals')).rows).toEqual([{ active_seconds: 2, elapsed_seconds: 3 }]);
			expect((await query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 1 }]);
			const after = (await query('SELECT * FROM capacity_provider_assignments ORDER BY id')).rows;
			await expect(maintainCapacityWorkdayRuns(recovery, 'team', cancelNow)).rejects.toThrow('Terminal workday a-old-workday');
			expect((await query('SELECT * FROM capacity_provider_assignments ORDER BY id')).rows).toEqual(after);
			expect((await query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 1 }]);
		} finally { await db.close(); }
	});
});
