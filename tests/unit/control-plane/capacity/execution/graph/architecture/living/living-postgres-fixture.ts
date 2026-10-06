import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createControlPlanePostgresDatabase } from '../../../../../../../../src/api/support/control-plane-postgres.ts';
import { createExecutionGraphService } from '../../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';

// Missing native PostgreSQL is a failing prerequisite, never a skipped pass.
// No server is installed/launched and no existing database is altered here.
export async function postgresGraph() {
	const value = process.env.TREESEED_TEST_POSTGRES_URL;
	if (!value) throw new Error('ARCHITECTURE_POSTGRES_REQUIRED: Explicit disposable PostgreSQL required');
	const connection = new URL(value);
	if (connection.hostname !== '127.0.0.1' || connection.pathname !== '/postgres') throw new Error('ARCHITECTURE_POSTGRES_SCOPE: Disposable loopback administrator database required');
	const admin = new pg.Pool({ connectionString: connection.href });
	const name = `treeseed_graph_test_${randomUUID().replaceAll('-', '')}`;
	let created = false;
	const databases: ReturnType<typeof createControlPlanePostgresDatabase>[] = [];
	const close = async () => {
		try { await Promise.all(databases.map(database => database.close())); }
		finally { try { if (created) await admin.query(`DROP DATABASE "${name}"`); } finally { await admin.end(); } }
	};
	try {
		await admin.query(`CREATE DATABASE "${name}"`); created = true; connection.pathname = `/${name}`;
		const left = createControlPlanePostgresDatabase(connection.href, { migrationMode: 'apply' }); databases.push(left);
		await left.migrate();
		const right = createControlPlanePostgresDatabase(connection.href); databases.push(right);
		await left.pool.query("INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ('team','graph-team','Graph team',$1,$1)", ['2026-10-03T00:00:00.000Z']);
		const store = (database: typeof left) => ({
			all: async (sql: string, params: unknown[] = []) => (await database.prepare(sql).bind(...params).all()).results,
			first: (sql: string, params: unknown[] = []) => database.prepare(sql).bind(...params).first(),
			batch: (operations: Array<{ query: string; params: unknown[] }>) => database.batch(operations),
		});
		const stores = [store(left), store(right)];
		const snapshot = async () => ({
			nodes: (await left.pool.query('SELECT * FROM execution_nodes ORDER BY id')).rows,
			edges: (await left.pool.query('SELECT * FROM execution_edges ORDER BY id')).rows,
			revisions: (await left.pool.query('SELECT * FROM execution_graph_revisions ORDER BY team_id,revision')).rows,
			assignments: (await left.pool.query('SELECT * FROM capacity_provider_assignments ORDER BY id')).rows,
			reservations: (await left.pool.query('SELECT * FROM capacity_reservations ORDER BY id')).rows,
		});
		return { left, right, stores, snapshot, close, name, connectionString: connection.href, reader: createExecutionGraphService(stores[0]), principal: { id: 'operator', roles: ['admin'] } };
	} catch (error) { await close(); throw error; }
}
