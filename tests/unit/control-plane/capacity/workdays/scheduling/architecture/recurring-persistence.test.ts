import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CapacityWorkdayScheduleService } from '../../../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-schedule-service.ts';
import { splitPostgresSqlStatements } from '../../../../../../../src/api/persistence/postgres-sql-statements.ts';
import { closeoutDatabase } from '../../../execution/graph/architecture/closeout-sql-fixture.ts';

// Actual schedule service, original DDL and real workday repository. The seeded
// start receipt is controlled input, NOT a new successful preflight/start,
// provider dispatch, recurring campaign, authenticated HTTP or native usage.
async function recurrence() {
	const base = await closeoutDatabase(); try {
		const original = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'));
		for (const table of ['capacity_workday_schedules', 'capacity_operation_receipts']) {
			const ddl = original.filter(sql => sql.startsWith(`CREATE TABLE "${table}" (`));
			if (ddl.length !== 1) throw new Error(`Original ${table} DDL required`); await base.db.exec(ddl[0]!);
		}
		await base.db.exec(readFileSync('drizzle/control-plane/0034_recurring_workday_canonical_intent.sql', 'utf8'));
		const guarded: string[] = [], store = { ...base.owner,
			getCapacityWorkdayRun: (teamId: string, id: string) => base.reads.get(teamId, id),
			createCapacityWorkdayRun: async () => { guarded.push('create'); throw new Error('Unrelated initial admission is outside this receipt-replay fixture'); },
			preflightCapacityWorkdayRunRequest: async () => { guarded.push('preflight'); throw new Error('Unrelated preflight is outside this receipt-replay fixture'); } };
		const service = new CapacityWorkdayScheduleService(store), intent = { schemaVersion: 'treeseed.workday-intent/v1', teamId: 'team', profileId: 'default',
			projects: ['project'], executionMode: 'simulation', startsAt: '2026-10-02T21:00:00.000Z', durationSeconds: 60,
			planningOnly: true, allocation: { allocationWeight: 1, planningPercent: 20 }, operatorConstraints: { providerIds: ['provider'], maxConcurrency: 1 } };
		const create = (id = 'schedule') => service.create('team', { id, purpose: 'Governed recurrence', intent, cadenceSeconds: 60, nextRunAt: intent.startsAt });
		const seedReceipt = async (scheduleId = 'schedule') => {
			const claim = `schedule-${scheduleId}-2`, key = `workday-schedule:${scheduleId}:${claim}`;
			const receipt = { schemaVersion: 'treeseed.workday-start-receipt/v1', workdayId: 'workday', preflightId: claim,
				preflightDigest: `sha256:${'d'.repeat(64)}`, acceptedExecutionNodeIds: [], assignmentIds: [], reservationIds: [],
				startedAt: intent.startsAt, providerReceiptRefs: [], transactionReceiptId: 'controlled-start-receipt' };
			await base.query(`UPDATE capacity_workday_schedules SET last_run_id=?,state_version=2 WHERE id=? AND team_id='team'`, [claim, scheduleId]);
			await base.query(`INSERT INTO capacity_operation_receipts (id,team_id,operation,idempotency_key,request_digest,resource_type,resource_id,response_json,created_at,updated_at)
				VALUES (?,'team','workday.start',?,'controlled-request','workday_start','workday',?,?,?)`, [scheduleId, key, JSON.stringify(receipt), intent.startsAt, intent.startsAt]);
			return receipt;
		};
		const snapshot = async () => ({ schedules: (await base.query('SELECT * FROM capacity_workday_schedules ORDER BY id')).rows,
			receipts: (await base.query('SELECT * FROM capacity_operation_receipts ORDER BY id')).rows, workdays: (await base.query('SELECT * FROM capacity_workday_runs ORDER BY id')).rows,
			assignments: (await base.query('SELECT * FROM capacity_provider_assignments ORDER BY id')).rows, reservations: (await base.query('SELECT * FROM capacity_reservations ORDER BY id')).rows });
		return { ...base, guarded, service, intent, create, seedReceipt, snapshot };
	} catch (error) { await base.db.close(); throw error; }
}
describe('real owning recurring schedule SQL and durable start receipt replay', () => {
	it('persists one high-level recurring intent with exact mode and no duplicate derived capacity authority', async () => {
		const f = await recurrence(); try {
			const before = structuredClone(f.intent), created = await f.create(); expect(created?.intent).toEqual(before);
			const rows = (await f.query("SELECT * FROM capacity_workday_schedules WHERE id='schedule'")).rows;
			expect(rows).toHaveLength(1); for (const retired of ['time_policy_json', 'available_seconds', 'publication_policy_json', 'planning_only']) expect(rows[0]).not.toHaveProperty(retired);
			expect(f.intent).toEqual(before); expect(f.guarded).toEqual([]);
		} finally { await f.db.close(); }
	});
	it('replays the existing canonical start receipt into the same workday without another preflight run reservation or assignment', async () => {
		const f = await recurrence(); try {
			await f.create(); const receipt = await f.seedReceipt(), before = await f.snapshot();
			const first = await f.service.tick('team', 'schedule', '2026-10-02T21:00:10.000Z');
			expect(first?.action).toBe('replayed'); expect(first?.run?.id).toBe(receipt.workdayId); expect(first?.schedule?.lastRunId).toBe(receipt.workdayId);
			const after = await f.snapshot(); expect(after.receipts).toEqual(before.receipts); expect(after.workdays).toEqual(before.workdays);
			expect(after.assignments).toEqual(before.assignments); expect(after.reservations).toEqual(before.reservations);
			const second = await f.service.tick('team', 'schedule', '2026-10-02T21:00:20.000Z'); expect(second?.action).toBe('active_run');
			expect(await f.snapshot()).toEqual(after); expect(f.guarded).toEqual([]);
		} finally { await f.db.close(); }
	});
	it('concurrent conflicting schedule edits have one version winner without losing the original immutable intent or running workday', async () => {
		const f = await recurrence(); try {
			await f.create(); const before = await f.snapshot();
			const outcomes = await Promise.allSettled([f.service.update('team', 'schedule', { stateVersion: 1, purpose: 'first' }),
				f.service.update('team', 'schedule', { stateVersion: 1, purpose: 'second' })]);
			expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
			expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
			const current = await f.service.get('team', 'schedule'); expect(current?.stateVersion).toBe(2); expect(current?.intent).toEqual(f.intent);
			const after = await f.snapshot(); expect(after.workdays).toEqual(before.workdays); expect(after.assignments).toEqual(before.assignments); expect(after.reservations).toEqual(before.reservations);
			await expect(f.service.update('team', 'schedule', { stateVersion: 1, status: 'paused' })).rejects.toMatchObject({ code: 'capacity_workday_schedule_version_stale' });
			expect(await f.snapshot()).toEqual(after);
		} finally { await f.db.close(); }
	});
	it('late native receipt-link interruption retains prior start truth and retries without duplicate dispatch or financial mutation', async () => {
		const f = await recurrence(); try {
			await f.create(); await f.seedReceipt(); const before = await f.snapshot();
			await f.db.exec(`CREATE FUNCTION isolated_schedule_stop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
				IF NEW.last_run_id='workday' THEN RAISE EXCEPTION 'isolated receipt-link interruption'; END IF; RETURN NEW; END $$;
				CREATE TRIGGER isolated_schedule_stop BEFORE UPDATE ON capacity_workday_schedules FOR EACH ROW EXECUTE FUNCTION isolated_schedule_stop();`);
			await expect(f.service.tick('team', 'schedule', '2026-10-02T21:00:10.000Z')).rejects.toThrow('isolated receipt-link interruption');
			expect(await f.snapshot()).toEqual(before);
			await f.db.exec('DROP TRIGGER isolated_schedule_stop ON capacity_workday_schedules; DROP FUNCTION isolated_schedule_stop();');
			expect((await f.service.tick('team', 'schedule', '2026-10-02T21:00:10.000Z'))?.action).toBe('replayed');
			const after = await f.snapshot(); expect(after.receipts).toEqual(before.receipts); expect(after.assignments).toEqual(before.assignments); expect(after.reservations).toEqual(before.reservations);
			expect(f.guarded).toEqual([]);
		} finally { await f.db.close(); }
	});
	it('foreign paused and future schedules cannot start work or rewrite existing workday custody', async () => {
		const f = await recurrence(); try {
			await f.create(); let before = await f.snapshot(); expect(await f.service.tick('foreign-team', 'schedule')).toBeNull(); expect(await f.snapshot()).toEqual(before);
			await f.service.update('team', 'schedule', { stateVersion: 1, status: 'paused' }); before = await f.snapshot();
			expect((await f.service.tick('team', 'schedule', '2026-10-02T21:00:10.000Z'))?.action).toBe('inactive'); expect(await f.snapshot()).toEqual(before);
			await f.service.update('team', 'schedule', { stateVersion: 2, status: 'active', nextRunAt: '2026-10-02T22:00:00.000Z' }); before = await f.snapshot();
			expect((await f.service.tick('team', 'schedule', '2026-10-02T21:00:10.000Z'))?.action).toBe('not_due'); expect(await f.snapshot()).toEqual(before); expect(f.guarded).toEqual([]);
		} finally { await f.db.close(); }
	});
});
