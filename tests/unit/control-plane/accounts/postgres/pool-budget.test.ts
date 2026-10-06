import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { createControlPlanePostgresDatabase } from '../../../../../src/api/support/control-plane-postgres.ts';
import { API_POSTGRES_POOL_MAX, API_POSTGRES_POOL_OPTIONS, API_POSTGRES_PROCESS_SLOTS,
	API_POSTGRES_RESERVED_CONNECTIONS, API_POSTGRES_RUNTIME_CONNECTION_LIMIT } from '../../../../../src/api/support/postgres-pool-budget.ts';

it('bounds every owned application pool and leaves allocation headroom during development overlap', async () => {
	const database = createControlPlanePostgresDatabase('postgres://unused@127.0.0.1/unused');
	try {
		expect(database.pool.options).toMatchObject(API_POSTGRES_POOL_OPTIONS);
		expect(API_POSTGRES_POOL_MAX * API_POSTGRES_PROCESS_SLOTS + API_POSTGRES_RESERVED_CONNECTIONS)
			.toBe(API_POSTGRES_RUNTIME_CONNECTION_LIMIT);
		expect(API_POSTGRES_RUNTIME_CONNECTION_LIMIT).toBe(20);
		expect(API_POSTGRES_POOL_OPTIONS.connectionTimeoutMillis).toBeGreaterThan(0);
		expect(API_POSTGRES_POOL_OPTIONS.idleTimeoutMillis).toBeGreaterThan(0);
	} finally { await database.close(); }
});

const url = process.env.TREESEED_TEST_POSTGRES_URL;
it.skipIf(!url)('queues concurrent work across four pools within the actual PostgreSQL role limit', async () => {
	const connection = new URL(url!);
	if (!['127.0.0.1', 'localhost'].includes(connection.hostname) || connection.pathname !== '/postgres') {
		throw new Error('Disposable local PostgreSQL required');
	}
	const admin = new pg.Pool({ connectionString: connection.href, max: 1 });
	const role = `pool_budget_${randomBytes(8).toString('hex')}`;
	const password = randomBytes(32).toString('hex');
	const databases: ReturnType<typeof createControlPlanePostgresDatabase>[] = [];
	const held: pg.PoolClient[] = [];
	let created = false;
	try {
		await admin.query(`CREATE ROLE ${role} LOGIN CONNECTION LIMIT ${API_POSTGRES_RUNTIME_CONNECTION_LIMIT} PASSWORD '${password}'`);
		created = true;
		connection.username = role; connection.password = password;
		for (let i = 0; i < API_POSTGRES_PROCESS_SLOTS; i++) databases.push(createControlPlanePostgresDatabase(connection.href));
		await Promise.all(databases.flatMap(database => Array.from({ length: API_POSTGRES_POOL_MAX }, async () => {
			held.push(await database.pool.connect());
		})));
		const occupancy = await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename=$1', [role]);
		expect(occupancy.rows[0].count).toBe(16);
		// Every pool is full: requests must wait locally, not open a 17th+ connection.
		const work = databases.flatMap(database => Array.from({ length: 12 }, () => database.pool.query('SELECT pg_sleep(0.01), 1 AS ok')));
		expect(databases.every(database => database.pool.totalCount === API_POSTGRES_POOL_MAX)).toBe(true);
		for (const client of held.splice(0)) client.release();
		const results = await Promise.all(work);
		expect(results).toHaveLength(48);
		expect(results.every(result => result.rows[0].ok === 1)).toBe(true);
	} finally {
		for (const client of held) client.release();
		await Promise.all(databases.map(database => database.close()));
		if (created) await admin.query(`DROP ROLE ${role}`);
		await admin.end();
	}
}, 30_000);
