import type { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { ControlPlanePostgresDatabase } from '../../../src/api/support/control-plane-postgres.ts';

function databaseWithDeadlocks(count: number) {
	const queries: string[] = [];
	let failures = count;
	let releases = 0;
	const client = {
		async query(sql: string) {
			queries.push(sql);
			if (sql === 'SELECT 1' && failures-- > 0) throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
			return { rows: [{ value: 1 }], rowCount: 1 };
		},
		release() { releases += 1; },
	};
	const pool = { on() { return this; }, async connect() { return client; } } as unknown as Pool;
	const database = ControlPlanePostgresDatabase.fromPool(pool);
	vi.spyOn(database, 'migrate').mockResolvedValue(undefined);
	return { database, queries, releases: () => releases };
}

it('retries a rolled-back SQL batch after a PostgreSQL deadlock', async () => {
	const { database, queries, releases } = databaseWithDeadlocks(1);
	await expect(database.batch([{ query: 'SELECT 1' }])).resolves.toMatchObject([{ success: true }]);
	expect(queries).toEqual(['BEGIN', 'SELECT 1', 'ROLLBACK', 'BEGIN', 'SELECT 1', 'COMMIT']);
	expect(releases()).toBe(2);
});

it('bounds SQL batch deadlock retries without retrying unrelated failures', async () => {
	const { database, queries, releases } = databaseWithDeadlocks(3);
	await expect(database.batch([{ query: 'SELECT 1' }])).rejects.toMatchObject({ code: '40P01' });
	expect(queries.filter(query => query === 'SELECT 1')).toHaveLength(3);
	expect(queries.filter(query => query === 'ROLLBACK')).toHaveLength(3);
	expect(releases()).toBe(3);
});
