import type { PoolClient } from 'pg';
import type { CapacityGovernanceDatabase } from './database.ts';
import { executePostgresBatch, translateControlPlaneSqlToPostgres } from '../support/control-plane-postgres.ts';

/** Pin authority reads, row locks, settlement, and projection to one connection. */
export async function capacityTransaction<T>(store: CapacityGovernanceDatabase,
	apply: (database: CapacityGovernanceDatabase) => Promise<T>): Promise<T> {
	const db = (store as CapacityGovernanceDatabase & { db?: {
		transaction<R>(run: (client: PoolClient) => Promise<R>): Promise<R>;
	} }).db;
	if (!db?.transaction) throw new Error('Capacity accounting requires the configured PostgreSQL transaction authority.');
	return db.transaction(async client => {
		const query = (sql: string, params: unknown[] = []) => client.query(translateControlPlaneSqlToPostgres(sql), params);
		return apply({
			ensureInitialized: async () => {},
			run: async (sql, params) => { await query(sql, params); },
			first: async <R extends Record<string, unknown>>(sql: string, params?: unknown[]) => (await query(sql, params)).rows[0] as R ?? null,
			all: async <R extends Record<string, unknown>>(sql: string, params?: unknown[]) => (await query(sql, params)).rows as R[],
			batch: operations => executePostgresBatch(client, operations),
		});
	});
}
