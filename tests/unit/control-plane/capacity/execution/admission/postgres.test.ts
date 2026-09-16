import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { assignmentAttemptSchema, calculateAssignmentAllocation } from '@treeseed/sdk/agent-capacity';
import { createControlPlanePostgresDatabase } from '../../../../../../src/api/support/control-plane-postgres.ts';
import { admitLivingExecutionAssignment } from '../../../../../../src/api/capacity/services/capacity/assignments/admission/living-execution-admission.ts';
import { assignment } from '../fixtures/assignment.ts';
import { ProviderAssignmentRepository } from '../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import { buildProviderAssignmentExplanation } from '../../../../../../src/api/capacity/services/capacity/assignments/observability/assignment-explanation-service.ts';

const url = process.env.TREESEED_TEST_POSTGRES_URL;
describe.skipIf(!url)('living admission in disposable PostgreSQL', () => {
	it('serializes competing claims and rolls back without orphan reservations or duplicate charges', async () => {
		const connection = new URL(url!);
		if (connection.hostname !== '127.0.0.1' || connection.pathname !== '/postgres') throw new Error('Explicit disposable loopback PostgreSQL required.');
		const admin = new pg.Pool({ connectionString: connection.href });
		const name = `treeseed_allocation_test_${randomUUID().replaceAll('-', '')}`;
		await admin.query(`CREATE DATABASE "${name}"`);
		connection.pathname = `/${name}`;
		const database = createControlPlanePostgresDatabase(connection.href, { migrationMode: 'apply' });
		try {
			await database.migrate();
			const now = assignment.createdAt;
			await database.pool.query(`INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ('team','team','Team',$1,$1)`, [now]);
			await database.pool.query(`INSERT INTO projects (id,team_id,slug,name,created_at,updated_at) VALUES ('project','team','project','Project',$1,$1)`, [now]);
			await database.pool.query(`INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,created_at,updated_at) VALUES ('class','team','project','engineer','Engineer',$1,$1)`, [now]);
			await database.pool.query(`INSERT INTO capacity_providers (id,fingerprint,public_jwk_json,display_name,created_at,updated_at) VALUES ('provider','test','{}','Provider',$1,$1)`, [now]);
			await database.pool.query(`INSERT INTO capacity_provider_team_memberships (id,team_id,capacity_provider_id,approved_at,approved_by_id,created_at,updated_at) VALUES ('membership','team','provider',$1,'test',$1,$1)`, [now]);
			await database.pool.query(`INSERT INTO capacity_execution_providers (id,capacity_provider_id,display_name,adapter,native_unit,max_concurrent_runners,created_at,updated_at) VALUES ('codex','provider','Codex','codex','seconds',1,$1,$1)`, [now]);
			await database.pool.query(`INSERT INTO capacity_provider_lanes (id,capacity_provider_id,execution_provider_id,display_name,purpose,max_concurrent_runners,created_at,updated_at) VALUES ('workday','provider','codex','Workday','workday',1,$1,$1)`, [now]);
			await database.pool.query(`INSERT INTO capacity_provider_availability_sessions
				(id,membership_id,team_id,capacity_provider_id,opened_at,refreshed_at,expires_at,available_from,created_at,updated_at)
				VALUES ('session','membership','team','provider',$1,$1,$2,$1,$1,$1)`, [now, assignment.deadline]);
			const observed = { day: now.slice(0, 10), observedAt: now, healthy: true, activeSeconds: 1, reservedSeconds: 0 };
			await database.pool.query(`UPDATE capacity_provider_availability_sessions SET execution_providers_json=$1 WHERE id='session'`,
				[JSON.stringify([{ id: 'codex-implementation', nativeLimits: { modelConfigurationId: 'terra-medium' },
					accountingObservation: { modelUsage: observed, capabilityUsage: { 'code-change': observed } } }])]);
			const store = { ensureInitialized: () => database.migrate(),
				run: async (sql: string, params: unknown[] = []) => { await database.prepare(sql).bind(...params).run(); },
				first: (sql: string, params: unknown[] = []) => database.prepare(sql).bind(...params).first(),
				all: async (sql: string, params: unknown[] = []) => (await database.prepare(sql).bind(...params).all()).results,
				batch: (operations: Array<{ query: string; params?: unknown[] }>) => database.batch(operations),
				getProviderAssignment: (team: string, id: string) => database.prepare(`SELECT id,execution_node_id AS "executionNodeId",
					execution_node_revision AS "executionNodeRevision" FROM capacity_provider_assignments WHERE team_id=? AND id=?`).bind(team, id).first(),
			};
			const attempts = ['first', 'second'].map(id => assignmentAttemptSchema.parse({ ...assignment,
				id, idempotencyKey: id, nodeId: id, reservationId: `reservation-${id}` }));
			for (const attempt of attempts) await database.prepare(`INSERT INTO execution_nodes
				(id,team_id,project_id,workday_id,kind,source_ref_json,rule_revision,node_revision,agent_class,status,
				graph_revision_created,graph_revision_updated,created_at,updated_at) VALUES (?,?,?,?,?,'{}',1,1,'engineer','ready',1,2,?,?)`)
				.bind(attempt.nodeId, attempt.teamId, attempt.projectId, attempt.workdayId, 'acting', attempt.createdAt, attempt.createdAt).run();
			const run = (attempt: typeof attempts[number]) => admitLivingExecutionAssignment(store as never, {
				principal: { teamId: 'team', capacityProviderId: 'provider', membershipId: 'membership' } as never,
				assignment: attempt, allocation: calculateAssignmentAllocation({ estimate: attempt.estimate, measurements: [],
					constraints: [{ id: 'model-day', remainingSeconds: 3 }] }),
				accountingLimits: { modelConfigurationId: 'terra-medium', dailyActiveSecondsLimit: 4, capabilityLimits: { 'code-change': { dailyActiveSecondsLimit: 4 } } },
				projectAgentClassId: 'class', providerSessionId: 'session', executionProviderId: 'codex', laneId: 'workday', lanePurpose: 'workday',
				executionKind: 'workday', predecessorResults: [], treedxProxyHandle: { id: `tdx-${attempt.id}` }, now: attempt.createdAt,
			});
			const results = await Promise.allSettled(attempts.map(run));
			expect(results.filter(result => result.status === 'fulfilled'), results.map(result => result.status === 'rejected' ? String(result.reason) : 'admitted').join('\n')).toHaveLength(1);
			const counters = await database.pool.query('SELECT committed_amount FROM capacity_admission_counters');
			expect(counters.rows).toEqual([{ committed_amount: 4 }, { committed_amount: 4 }]);
			expect((await database.pool.query('SELECT count(*)::int AS count FROM capacity_reservations')).rows[0].count).toBe(1);
			const winner = attempts[results.findIndex(result => result.status === 'fulfilled')]!;
			await run(winner);
			const admitted = await new ProviderAssignmentRepository(store as never).get('team', winner.id);
			expect(admitted?.explanation)
				.toMatchObject({ metadata: { allocation: { admitted: true } } });
			expect(buildProviderAssignmentExplanation(admitted!, 'team', { source: 'lease_next_assignment', eligible: true }, now))
				.toMatchObject({ metadata: { allocation: { admitted: true } } });
			expect((await database.pool.query('SELECT sum(reserved_amount)::int AS total FROM capacity_reservation_counter_claims')).rows[0].total).toBe(6);
			await database.pool.query(`UPDATE capacity_provider_assignments SET assignment_attempt_json='{}' WHERE id=$1`, [winner.id]);
			const repository = new ProviderAssignmentRepository(store as never);
			await expect(repository.get('team', winner.id)).rejects.toThrow('invalid assignment_attempt_json');
			expect(await repository.get('team', winner.id, true)).toMatchObject({
				id: winner.id, assignmentAttempt: null,
				explanation: { snapshotValidation: { valid: false, field: 'assignment_attempt_json' } },
			});
			await expect(repository.get('team', winner.id)).rejects.toThrow('invalid assignment_attempt_json');
			expect(await repository.get('other-team', winner.id, true)).toBeNull();
			expect(await repository.getForCancellation('team', winner.id)).toMatchObject({
				id: winner.id, status: 'pending', reservationId: winner.reservationId, assignmentAttempt: null,
			});
			expect(await repository.getForCancellation('other-team', winner.id)).toBeNull();
		} finally {
			await database.close();
			await admin.query(`DROP DATABASE "${name}"`); await admin.end();
		}
	}, 30_000);
});
