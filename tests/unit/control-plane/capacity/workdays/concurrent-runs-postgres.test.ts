import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createControlPlanePostgresDatabase } from '../../../../../src/api/support/control-plane-postgres.ts';
import { CapacityWorkdayRunService } from '../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-run-service.ts';

describe.skipIf(!process.env.TREESEED_TEST_POSTGRES_URL)('concurrent local execution in PostgreSQL', () => {
	it('preserves production and simulation workdays when another workday or conversation starts', async () => {
		const connection = new URL(process.env.TREESEED_TEST_POSTGRES_URL!);
		if (connection.hostname !== '127.0.0.1' || connection.pathname !== '/postgres') throw new Error('Disposable loopback PostgreSQL required.');
		const admin = new pg.Pool({ connectionString: connection.href });
		const name = `treeseed_runs_test_${randomUUID().replaceAll('-', '')}`;
		await admin.query(`CREATE DATABASE "${name}"`);
		connection.pathname = `/${name}`;
		const database = createControlPlanePostgresDatabase(connection.href, { migrationMode: 'apply' });
		try {
			await database.migrate();
			const now = new Date().toISOString();
			await database.pool.query(`INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ('team','team','Team',$1,$1)`, [now]);
			await database.pool.query(`INSERT INTO capacity_providers (id,fingerprint,public_jwk_json,display_name,created_at,updated_at) VALUES ('provider','test','{}','Provider',$1,$1)`, [now]);
			const store = {
				ensureInitialized: () => database.migrate(),
				run: (sql: string, values: unknown[]) => database.prepare(sql).bind(...values).run(),
				first: (sql: string, values: unknown[]) => database.prepare(sql).bind(...values).first(),
				all: async (sql: string, values: unknown[]) => (await database.prepare(sql).bind(...values).all()).results,
				batch: (operations: Array<{ query: string; params?: unknown[] }>) => database.batch(operations),
				scheduleCapacityWorkdayRun: vi.fn(async () => ({})),
				closeCapacityWorkdayAdmission: vi.fn(), terminalizeCapacityWorkdayAssignments: vi.fn(), terminalizeCapacityWorkdayEnvelopes: vi.fn(),
			};
			const service = new CapacityWorkdayRunService(store as never);
			for (const [id, executionMode, executionKind] of [
				['production', 'production', 'workday'], ['sdk', 'simulation', 'workday'],
				['api', 'simulation', 'workday'], ['chat', 'production', 'conversation'],
			]) await service.create('team', { id, executionMode, executionKind, capacityProviderId: 'provider', environment: 'local', status: 'running', startedAt: now, parameters: { durationSeconds: 600, allocationWeight: 1, planningPercent: 20 } });
			expect((await database.pool.query('SELECT id,status,error_json FROM capacity_workday_runs ORDER BY id')).rows)
				.toEqual(['api', 'chat', 'production', 'sdk'].map(id => ({ id, status: 'running', error_json: '{}' })));
			expect(store.scheduleCapacityWorkdayRun).toHaveBeenCalledTimes(4);
			expect(store.closeCapacityWorkdayAdmission).not.toHaveBeenCalled();
			expect(store.terminalizeCapacityWorkdayAssignments).not.toHaveBeenCalled();
			expect(store.terminalizeCapacityWorkdayEnvelopes).not.toHaveBeenCalled();
		} finally {
			await database.pool.end();
			await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
			await admin.end();
		}
	}, 30_000);
});
