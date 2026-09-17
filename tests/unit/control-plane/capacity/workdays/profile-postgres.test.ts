import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DEFAULT_WORKDAY_POLICY } from '@treeseed/sdk/agent-capacity';
import { createControlPlanePostgresDatabase } from '../../../../../src/api/support/control-plane-postgres.ts';
import { createWorkdayProfileService, readTeamWorkdayProfile } from '../../../../../src/api/control-plane/repositories/capacity/workdays/profile-service.ts';

describe.skipIf(!process.env.TREESEED_TEST_POSTGRES_URL)('team policy concurrency in PostgreSQL', () => {
	it('preserves unrelated metadata and admits exactly one concurrent replacement', async () => {
		const connection = new URL(process.env.TREESEED_TEST_POSTGRES_URL!);
		if (connection.hostname !== '127.0.0.1' || connection.pathname !== '/postgres') throw new Error('Disposable loopback PostgreSQL required.');
		const admin = new pg.Pool({ connectionString: connection.href });
		const name = `treeseed_policy_test_${randomUUID().replaceAll('-', '')}`;
		await admin.query(`CREATE DATABASE "${name}"`);
		connection.pathname = `/${name}`;
		const database = createControlPlanePostgresDatabase(connection.href, { migrationMode: 'apply' });
		try {
			await database.migrate();
			await database.pool.query(`INSERT INTO teams (id,slug,name,metadata_json,created_at,updated_at)
				VALUES ('team','team','Team','{"unrelated":{"preserve":true}}',$1,$1)`, [new Date().toISOString()]);
			const store = {
				first: (sql: string, params: unknown[]) => database.prepare(sql).bind(...params).first(),
				principalCanAccessTeam: async () => true,
				getTeamAccessSummary: async () => ({ permissions: ['teams:manage:team'] }),
			};
			const frozen = await readTeamWorkdayProfile(store, 'team');
			const service = createWorkdayProfileService(store);
			const results = await Promise.allSettled([30, 40].map(planningPercent => service.profilesUpdate(
				{ id: 'owner' }, 'team', 'default', { policy: { ...DEFAULT_WORKDAY_POLICY, planningPercent } }, '1')));
			expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
			expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'workday_profile_precondition_failed' } });
			expect(await readTeamWorkdayProfile(store, 'team')).toMatchObject({ revision: 2 });
			expect(frozen).toMatchObject({ revision: 1, policy: { planningPercent: 20 } });
			const row = (await database.pool.query('SELECT metadata_json FROM teams WHERE id=$1', ['team'])).rows[0];
			expect(JSON.parse(row.metadata_json).unrelated).toEqual({ preserve: true });
		} finally {
			await database.pool.end();
			await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
			await admin.end();
		}
	}, 30_000);
});
