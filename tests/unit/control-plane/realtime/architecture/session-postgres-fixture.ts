import assert from 'node:assert/strict';
import pg, { type Pool, type PoolClient } from 'pg';
import { ControlPlaneStore } from '../../../../../src/api/persistence/store.ts';
import { SessionEventService } from '../../../../../src/api/realtime/session-events.ts';
import { postgresGraph } from '../../capacity/execution/graph/architecture/living/living-postgres-fixture.ts';

// Transport-observation timeout only: no assignment/productive authority is
// created or changed by this event component fixture.
export async function eventObserved(predicate: () => boolean | Promise<boolean>) {
	const until = Date.now() + 5_000;
	while (!await predicate()) {
		assert.ok(Date.now() < until, 'Native session event observation did not complete');
		await new Promise<void>(resolve => setTimeout(resolve, 1));
	}
}

export async function sessionPostgres() {
	const f = await postgresGraph();
	const pools: Array<{ pool: Pool; checkedOut: Set<PoolClient> }> = [];
	try {
		const left = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, f.left);
		const right = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, f.right);
		left.initializationPromise = Promise.resolve(); right.initializationPromise = Promise.resolve();
		const trackedPool = (connectionString = f.connectionString) => {
			const pool = new pg.Pool({ connectionString, max: 1 }), checkedOut = new Set<PoolClient>();
			// Native pg lifecycle events only, no connect/query/notification override.
			pool.on('acquire', client => checkedOut.add(client));
			pool.on('release', (_error, client) => checkedOut.delete(client));
			pools.push({ pool, checkedOut }); return pool;
		};
		const listenerPool = trackedPool();
		const listenerClient = () => {
			const owned = pools.find(value => value.pool === listenerPool);
			assert.ok(owned); assert.equal(owned.checkedOut.size, 1);
			const client = [...owned.checkedOut][0]; assert.ok(client); return client;
		};
		const publisher = new SessionEventService(left), subscriber = new SessionEventService(right, listenerPool);
		const rows = async () => (await f.right.pool.query('SELECT * FROM session_events ORDER BY sequence')).rows;
		const snapshot = async () => ({ ...await f.snapshot(),
			usage: (await f.right.pool.query('SELECT * FROM capacity_usage_actuals ORDER BY id')).rows,
			ledger: (await f.right.pool.query('SELECT * FROM capacity_ledger_entries ORDER BY id')).rows });
		return { ...f, publisher, subscriber, listenerPool, listenerClient, trackedPool, rightStore: right, rows, snapshot,
			async close() {
				// Test failure cleanup is not evidence that the service released its
				// client. Tests assert service cleanup BEFORE this safety finally.
				try {
					for (const owned of pools) {
						for (const client of [...owned.checkedOut]) client.release(true);
						await owned.pool.end();
					}
				} finally { await f.close(); }
			} };
	} catch (error) {
		try { for (const owned of pools) { for (const client of [...owned.checkedOut]) client.release(true); await owned.pool.end(); } }
		finally { await f.close(); }
		throw error;
	}
}
