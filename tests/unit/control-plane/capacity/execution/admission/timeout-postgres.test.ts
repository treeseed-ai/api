import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createControlPlanePostgresDatabase } from '../../../../../../src/api/support/control-plane-postgres.ts';
import type { CapacityGovernanceDatabase } from '../../../../../../src/api/capacity/database.ts';
import { ProviderAssignmentLifecycleService } from '../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-lifecycle-service.ts';
import { ProviderAssignmentRepository } from '../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';

const url = process.env.TREESEED_TEST_POSTGRES_URL;
describe.skipIf(!url)('terminal timeout PostgreSQL custody', () => {
	it('settles the expired current owner once without allowing late completion or a stale token', async () => {
		const connection = new URL(url!);
		if (connection.hostname !== '127.0.0.1' || connection.pathname !== '/postgres') throw new Error('Explicit disposable loopback PostgreSQL required.');
		const admin = new pg.Pool({ connectionString: connection.href });
		const name = `treeseed_timeout_test_${randomUUID().replaceAll('-', '')}`;
		await admin.query(`CREATE DATABASE "${name}"`);
		connection.pathname = `/${name}`;
		const db = createControlPlanePostgresDatabase(connection.href, { migrationMode: 'apply' });
		try {
			await db.migrate();
			const now = new Date().toISOString(), expired = new Date(Date.now() - 1000).toISOString();
			await db.pool.query(`INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ('team','team','Team',$1,$1)`, [now]);
			await db.pool.query(`INSERT INTO projects (id,team_id,slug,name,created_at,updated_at) VALUES ('project','team','project','Project',$1,$1)`, [now]);
			await db.pool.query(`INSERT INTO capacity_providers (id,fingerprint,public_jwk_json,display_name,created_at,updated_at) VALUES ('provider','test','{}','Provider',$1,$1)`, [now]);
			await db.pool.query(`INSERT INTO capacity_provider_team_memberships (id,team_id,capacity_provider_id,approved_at,approved_by_id,created_at,updated_at) VALUES ('membership','team','provider',$1,'test',$1,$1)`, [now]);
			await db.pool.query(`INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,created_at,updated_at) VALUES ('engineer','team','project','engineer','Engineer',$1,$1)`, [now]);
			await db.pool.query(`INSERT INTO capacity_provider_assignments
				(id,membership_id,team_id,project_id,capacity_provider_id,project_agent_class_id,mode,status,lease_state,
				lease_token,lease_expires_at,reservation_id,created_at,updated_at)
				VALUES ('assignment','membership','team','project','provider','engineer','acting','leased','leased','lease',$1,NULL,$2,$2)`, [expired, now]);
			await db.pool.query(`INSERT INTO capacity_reservations
				(id,idempotency_key,admission_token,membership_id,team_id,project_id,capacity_provider_id,project_agent_class_id,
				assignment_id,mode,requested_seconds,reserved_seconds,created_at,updated_at)
				VALUES ('reservation','reservation','admission','membership','team','project','provider','engineer','assignment','acting',20,20,$1,$1)`, [now]);
			await db.pool.query(`UPDATE capacity_provider_assignments SET reservation_id='reservation' WHERE id='assignment'`);
			await db.pool.query(`UPDATE capacity_provider_assignments SET capacity_envelope_json=$1,decision_input_json=$2 WHERE id='assignment'`,
				[JSON.stringify({ teamId: 'team', projectId: 'project', mode: 'acting' }), JSON.stringify({ teamId: 'team', projectId: 'project', projectAgentClassId: 'engineer', mode: 'acting', input: {} })]);
			const store: CapacityGovernanceDatabase & { db: typeof db } = { db, ensureInitialized: () => db.migrate(),
				run: async (sql, params = []) => { await db.prepare(sql).bind(...params).run(); },
				first: (sql, params = []) => db.prepare(sql).bind(...params).first(),
				all: async (sql, params = []) => (await db.prepare(sql).bind(...params).all()).results,
				batch: operations => db.batch(operations) };
			const repository = new ProviderAssignmentRepository(store);
			const service = new ProviderAssignmentLifecycleService(Object.assign(store, {
				getProviderAssignment: repository.get.bind(repository),
			}) as ConstructorParameters<typeof ProviderAssignmentLifecycleService>[0]);
			const principal = { teamId: 'team', membershipId: 'membership', capacityProviderId: 'provider' };
			const failure = { leaseToken: 'lease', code: 'assignment_timeout', retryable: false,
				activeSeconds: 12, elapsedSeconds: 15, usage: { inputTokens: 200, outputTokens: 30 } };
			expect(await service.complete(principal, 'assignment', { leaseToken: 'lease' })).toBeNull();
			expect(await service.fail(principal, 'assignment', { ...failure, leaseToken: 'wrong' })).toBeNull();
			const outcomes = await Promise.all([service.fail(principal, 'assignment', failure), service.fail(principal, 'assignment', failure)]);
			expect(outcomes.filter(Boolean)).toHaveLength(1);
			expect((await repository.get('team', 'assignment'))?.status).toBe('failed');
			const reservation = await store.first('SELECT state,active_seconds,released_seconds FROM capacity_reservations WHERE id=?', ['reservation']);
			expect(reservation).toMatchObject({ state: 'consumed', active_seconds: 12, released_seconds: 8 });
			const usages = await store.all('SELECT active_seconds,input_tokens,output_tokens FROM capacity_usage_actuals WHERE assignment_id=?', ['assignment']);
			expect(usages).toHaveLength(1);
			expect(usages[0]).toMatchObject({ active_seconds: 12, input_tokens: 200, output_tokens: 30 });
		} finally {
			await db.close(); await admin.query(`DROP DATABASE "${name}"`); await admin.end();
		}
	}, 30_000);
});
