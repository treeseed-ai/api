import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeCapacityPageCursor, type CapacityPage } from '@treeseed/sdk/capacity-pagination';
import type { CapacityUsageActual } from '@treeseed/sdk/agent-capacity';
import { createCapacityQueryService } from '../../../../../../../src/api/control-plane/repositories/capacity/capacity-query-service.ts';
import { splitPostgresSqlStatements } from '../../../../../../../src/api/persistence/postgres-sql-statements.ts';
import { closeoutDatabase } from './closeout-sql-fixture.ts';
import { serializeTaskUsageActualRow } from '../../../../../../../src/api/capacity/repositories/capacity/accounting/task-usage.ts';

const principal = { id: 'isolated-reader', roles: ['admin'] };
async function fixture() {
	const base = await closeoutDatabase();
	try {
		const ddl = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'));
		for (const table of ['projects', 'capacity_usage_actuals']) {
			const statements = ddl.filter(sql => sql.startsWith(`CREATE TABLE "${table}" (`));
			if (statements.length !== 1) throw new Error(`Missing original DDL ${table}`);
			await base.db.exec(statements[0]!);
		}
		await base.query(`INSERT INTO projects (id,team_id,slug,name,created_at,updated_at)
			VALUES ('project','team','project','Isolated project',?,?)`, ['2026-10-02T21:00:00Z', '2026-10-02T21:00:00Z']);
		async function seed(index: number, project = 'project', workday = 'workday') {
			const id = `usage-${String(index).padStart(3, '0')}`;
			await base.query(`INSERT INTO capacity_usage_actuals (id,idempotency_key,project_id,work_day_id,task_signature,
				assignment_id,assignment_attempt,usage_dimension,accounting_mode,business_model,active_seconds,elapsed_seconds,
				native_usage_json,metadata_json,created_at) VALUES (?,?,?,?,?,?,1,'aggregate','aggregate','isolated-test',1,1,?,?,?)`,
			[id, `key-${id}`, project, workday, 'isolated-task', index === 0 ? 'failed-assignment' : `assignment-${index}`,
				JSON.stringify({ activeSeconds: 1 }), JSON.stringify({ settlementKey: `settlement-${index}` }), '2026-10-02T21:00:01.000Z']);
		}
		return { ...base, seed, service: createCapacityQueryService(base.store) };
	} catch (error) { await base.db.close(); throw error; }
}
// REAL owning SQL/operator evidence/service, supplied measurements only. No
// actual provider charge, canonical UsageSettlement, live DB or server concurrency claim.
describe('complete scoped usage observation through original SQL and owning service', () => {
	it('requires a valid stored usage timestamp without rewriting bytes or charging elapsed infrastructure time as active work', () => {
		const row = { id: 'usage', idempotency_key: 'key', project_id: 'project', task_signature: 'task',
			execution_profile_id: 'profile', assignment_attempt: 1, usage_dimension: 'aggregate', accounting_mode: 'aggregate',
			business_model: 'isolated-test', active_seconds: 0, elapsed_seconds: 2, native_usage_json: '{}', metadata_json: '{}',
			created_at: '2026-10-02T21:00:01.000Z' };
		for (const created_at of ['2026-10-02T21:00:01.000Z', '2026-10-02T21:00:01Z', '2026-10-02T17:00:01-04:00', '2024-02-29T00:00:00Z']) {
			const input = { ...row, created_at }, before = structuredClone(input);
			expect(serializeTaskUsageActualRow(input)).toMatchObject({ id: 'usage', activeSeconds: 0, elapsedSeconds: 2, createdAt: created_at });
			expect(input).toEqual(before);
		}
		const failures: unknown[] = [];
		for (const created_at of [undefined, null, 0, '', ' ', 'invalid', '2026-10-02', '2026-02-30T00:00:00Z', '2026-10-02T25:00:00Z']) {
			const input = { ...row, created_at }, before = structuredClone(input);
			try { serializeTaskUsageActualRow(input); failures.push('ADMITTED'); }
			catch (error) { failures.push(error); }
			expect(input).toEqual(before);
		}
		expect(failures).toHaveLength(9);
		for (const failure of failures) expect(failure).toMatchObject({ code: 'capacity_task_usage_corrupt', status: 500,
			details: { usageActualId: 'usage', column: 'created_at' } });
	});
	it('owning SQL usage reads retain malformed clock history and admit only an explicit valid-clock retry', async () => {
		const { db, query, seed, service } = await fixture();
		try {
			await seed(0); const retained = await query('SELECT * FROM capacity_usage_actuals ORDER BY id');
			const outcomes: unknown[] = [];
			for (const clock of ['invalid', '2026-10-02', '2026-02-30T00:00:00Z', '2026-10-02T25:00:00Z']) {
				await query('UPDATE capacity_usage_actuals SET created_at=?', [clock]);
				const before = await query('SELECT * FROM capacity_usage_actuals ORDER BY id');
				try { await service.usage(principal, 'team', { projectId: 'project' }); outcomes.push('ADMITTED'); }
				catch (error) { outcomes.push(error); }
				expect(await query('SELECT * FROM capacity_usage_actuals ORDER BY id')).toEqual(before);
			}
			for (const outcome of outcomes) expect(outcome).toMatchObject({ code: 'capacity_task_usage_corrupt', status: 500 });
			await query('UPDATE capacity_usage_actuals SET created_at=?', ['2026-10-02T21:00:01.000Z']);
			const page = await service.usage(principal, 'team', { projectId: 'project' });
			expect(page.items).toHaveLength(1); expect(page.items[0]).toMatchObject({ id: 'usage-000', createdAt: '2026-10-02T21:00:01.000Z' });
			expect(await query('SELECT * FROM capacity_usage_actuals ORDER BY id')).toEqual(retained);
		} finally { await db.close(); }
	});
	it('reads all measured usage beyond page one with exact project workday cursor and immutable repeated reads', async () => {
		const { db, query, seed, service } = await fixture();
		try {
			for (let index = 0; index < 101; index++) await seed(index);
			await seed(101, 'project', 'other-workday'); await seed(102, 'other-project');
			const before = await query('SELECT * FROM capacity_usage_actuals ORDER BY id');
			const first: CapacityPage<CapacityUsageActual> = await service.usage(principal, 'team', { projectId: 'project', workDayId: 'workday', limit: 100 });
			expect(first.items.map(value => value.id)).toEqual(Array.from({ length: 100 }, (_, index) => `usage-${String(100 - index).padStart(3, '0')}`));
			expect(first.items.every(value => value.projectId === 'project' && value.workDayId === 'workday')).toBe(true);
			expect(decodeCapacityPageCursor(first.page.nextCursor)).toEqual({ id: 'usage-001', createdAt: '2026-10-02T21:00:01.000Z' });
			const tail: CapacityPage<CapacityUsageActual> = await service.usage(principal, 'team', { projectId: 'project', workDayId: 'workday', limit: 100, cursor: first.page.nextCursor });
			expect(tail.items).toHaveLength(1); expect(tail.items[0]).toMatchObject({ id: 'usage-000', assignmentId: 'failed-assignment',
				accountingMode: 'aggregate', activeSeconds: 1, elapsedSeconds: 1, nativeUsage: { activeSeconds: 1 }, metadata: { settlementKey: 'settlement-0' } });
			expect(tail.page).toEqual({ limit: 100, hasMore: false, nextCursor: null });
			expect(await Promise.all([service.usage(principal, 'team', { projectId: 'project', workDayId: 'workday', limit: 100 }),
				service.usage(principal, 'team', { projectId: 'project', workDayId: 'workday', limit: 100, cursor: first.page.nextCursor })])).toEqual([first, tail]);
			expect(await query('SELECT * FROM capacity_usage_actuals ORDER BY id')).toEqual(before);
		} finally { await db.close(); }
	});
	it('denies missing authority corrupt native JSON and invalid pages while preserving explicit empty terminal evidence', async () => {
		const { db, query, seed, service } = await fixture();
		try {
			expect(await service.usage(principal, 'team', { projectId: 'project', workDayId: 'workday', limit: 100 }))
				.toEqual({ items: [], page: { limit: 100, hasMore: false, nextCursor: null } });
			await expect(service.usage(undefined, 'team', { projectId: 'project' })).rejects.toMatchObject({ status: 401 });
			await expect(service.usage(principal, 'foreign-team', { projectId: 'project' })).rejects.toMatchObject({ status: 404 });
			await expect(service.usage(principal, 'team', {})).rejects.toMatchObject({ status: 400 });
			for (const invalid of [{ limit: 0 }, { cursor: 'invalid' }]) await expect(service.usage(principal, 'team', { projectId: 'project', ...invalid })).rejects.toMatchObject({ status: 400 });
			await seed(0); await query('UPDATE capacity_usage_actuals SET native_usage_json=?', ['invalid']);
			await expect(service.usage(principal, 'team', { projectId: 'project' })).rejects.toMatchObject({ status: 500, code: 'capacity_task_usage_corrupt' });
		} finally { await db.close(); }
	});
	it('rejects corrupt stored creation clocks and zero measured productive time instead of returning valid-looking evidence', async () => {
		const { db, query, seed, service } = await fixture();
		try {
			await seed(0); const outcomes: string[] = [];
			for (const change of [{ createdAt: 'invalid', active: 1, elapsed: 1 }, { createdAt: '2026-10-02T21:00:01.000Z', active: 0, elapsed: 1 }]) {
				await query('UPDATE capacity_usage_actuals SET created_at=?,active_seconds=?,elapsed_seconds=?', [change.createdAt, change.active, change.elapsed]);
				try { await service.usage(principal, 'team', { projectId: 'project' }); outcomes.push('ADMITTED'); }
				catch (error) { outcomes.push((error as { code: string }).code); }
			}
			expect(outcomes).toEqual(['capacity_task_usage_corrupt', 'capacity_task_usage_corrupt']);
		} finally { await db.close(); }
	});
});
