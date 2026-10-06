import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { CapacityWorkdayScheduleService, serializeWorkdaySchedule } from '../../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-schedule-service.ts';
import { WorkdayPreflightService } from '../../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-preflight-service.ts';

const intent = { schemaVersion: 'treeseed.workday-intent/v1', teamId: 'team', profileId: 'default', projects: ['sdk'],
	startsAt: '2026-09-17T00:00:00.000Z', durationSeconds: 600, executionMode: 'production',
	allocation: { planningPercent: 20, allocationWeight: 2, projectPercentages: { sdk: 100 } } };
const row = () => ({ id: 'schedule', team_id: 'team', status: 'active', purpose: 'Useful work', intent_json: JSON.stringify(intent),
	cadence_seconds: 600, last_run_id: 'claimed', next_run_at: '2026-09-17T00:10:00.000Z', state_version: 2, created_at: intent.startsAt, updated_at: intent.startsAt });

describe('recurring workdays use canonical admission', () => {
	afterEach(() => vi.restoreAllMocks());
	it('routes the claimed occurrence through preflight/start with only high-level intent', async () => {
		const preflight = vi.spyOn(WorkdayPreflightService.prototype, 'preflight').mockResolvedValue({ id: 'preflight', preflightDigest: 'digest' } as never);
		const start = vi.spyOn(WorkdayPreflightService.prototype, 'start').mockResolvedValue({ workdayId: 'workday-real' } as never);
		const current = row();
		const direct = vi.fn();
		const store = { ensureInitialized: async () => {}, all: async () => [], createCapacityWorkdayRun: direct,
			first: async (sql: string) => sql.includes('capacity_operation_receipts') ? null : current,
			getCapacityWorkdayRun: async (_team: string, id: string) => id === 'workday-real' ? { id, status: 'running' } : null,
			run: async (_sql: string, args: unknown[]) => { current.last_run_id = String(args[0]); } };
		const service = new CapacityWorkdayScheduleService(store as never);
		const now = '2026-09-17T01:00:00.000Z';
		const result = await service.tick('team', 'schedule', now);
		expect(preflight).toHaveBeenCalledWith('team', { ...intent, startsAt: current.updated_at }, null, 'claimed');
		expect(start).toHaveBeenCalledWith('team', { preflightId: 'preflight', preflightDigest: 'digest', idempotencyKey: 'workday-schedule:schedule:claimed' }, null);
		expect(direct).not.toHaveBeenCalled();
		expect(result).toMatchObject({ action: 'created', run: { id: 'workday-real' }, schedule: { lastRunId: 'workday-real' } });
	});
	it('recovers the same start receipt without a second preflight or run', async () => {
		const preflight = vi.spyOn(WorkdayPreflightService.prototype, 'preflight');
		const current = row();
		const store = { ensureInitialized: async () => {},
			first: async (sql: string) => sql.includes('capacity_operation_receipts') ? { response_json: JSON.stringify({ workdayId: 'restored' }) } : current,
			getCapacityWorkdayRun: async (_team: string, id: string) => id === 'restored' ? { id, status: 'running' } : null,
			run: async (_sql: string, args: unknown[]) => { current.last_run_id = String(args[0]); } };
		const result = await new CapacityWorkdayScheduleService(store as never).tick('team', 'schedule');
		expect(result).toMatchObject({ action: 'replayed', run: { id: 'restored' } });
		expect(preflight).not.toHaveBeenCalled();
	});
	it('rejects retired schedule percentages and budgets rather than translating them', async () => {
		const service = new CapacityWorkdayScheduleService({} as never);
		for (const field of ['timePolicy', 'availableSeconds', 'maxActiveAssignments', 'projectIds']) {
			await expect(service.create('team', { intent, [field]: {} })).rejects.toThrow('Unsupported schedule fields');
		}
		expect(serializeWorkdaySchedule(row())?.intent).toEqual(intent);
	});
});

describe.skipIf(!process.env.TREESEED_TEST_POSTGRES_URL)('native PostgreSQL recurring-intent migration', () => {
	it('preserves schedule identity while removing all obsolete allocation columns', async () => {
		const connection = new URL(process.env.TREESEED_TEST_POSTGRES_URL!);
		if (!['127.0.0.1', 'localhost'].includes(connection.hostname) || connection.pathname !== '/postgres') throw new Error('Use local disposable PostgreSQL.');
		const admin = new pg.Pool({ connectionString: connection.href }), name = `treeseed_schedule_test_${randomUUID().replaceAll('-', '')}`;
		let pool: pg.Pool | undefined;
		try {
			await admin.query(`CREATE DATABASE "${name}"`); connection.pathname = `/${name}`;
			pool = new pg.Pool({ connectionString: connection.href });
			const baseline = readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8');
			const table = baseline.match(/CREATE TABLE "capacity_workday_schedules" \([\s\S]*?\n\);/u)?.[0];
			if (!table) throw new Error('Schedule baseline missing');
			await pool.query(table);
			await pool.query(`INSERT INTO capacity_workday_schedules VALUES ('schedule','team','provider','paused','Useful work','["sdk"]','{}',600,600,1,600,'{}',0,'{}',NULL,'2026-09-17T00:00:00.000Z',1,'prior','prior')`);
			await pool.query(readFileSync('drizzle/control-plane/0034_recurring_workday_canonical_intent.sql', 'utf8'));
			const saved = (await pool.query('SELECT * FROM capacity_workday_schedules')).rows[0];
			expect(serializeWorkdaySchedule(saved)).toMatchObject({ id: 'schedule', status: 'paused', intent: { projects: ['sdk'], durationSeconds: 600, operatorConstraints: { providerIds: ['provider'], maxConcurrency: 1 } } });
			for (const retired of ['time_policy_json', 'available_seconds', 'publication_policy_json', 'planning_only']) expect(saved).not.toHaveProperty(retired);
		} finally {
			await pool?.end(); await admin.query(`DROP DATABASE IF EXISTS "${name}"`); await admin.end();
		}
	});
});
