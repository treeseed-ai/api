import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createControlPlanePostgresDatabase } from '../../../../../../src/api/support/control-plane-postgres.ts';
import { ControlPlaneStore } from '../../../../../../src/api/persistence/store.ts';
import { createCapacityControlPlane } from '../../../../../../src/api/capacity/control-plane.ts';
import { ProviderAssignmentRepository } from '../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import { seedPlanningBoundary } from './fixtures/planning-boundary-postgres.ts';
import { terminalPerformance } from '../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/completion/assignment-terminal-performance.ts';
import { OperatorAssignmentService } from '../../../../../../src/api/capacity/services/capacity/assignments/observability/operator-assignment-service.ts';
import { settleCapacityReservationExactlyOnce } from '../../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { assignment } from '../fixtures/assignment.ts';
import { compileAssignmentTimeBudget } from '../../../../../../src/api/capacity/services/capacity/assignments/planning/assignment-time-budget.ts';

const url = process.env.TREESEED_TEST_POSTGRES_URL;
describe('terminal timeout PostgreSQL custody', () => {
	it.each([
		['12 seconds', 12, false, false, false],
		['25 seconds', 25, false, false, false],
		['phase timeout before periodic cancellation', 12, true, false, false],
		['phase stop after periodic cancellation', 12, true, true, false],
		['returned pre-model phase cancellation', 0, true, false, true],
	] as const)('settles actual %s once without late completion, cap expansion or approval', async (_label, activeSeconds, phase, requested, returned) => {
		const reservedSeconds = phase ? 31 : 20;
		if (!url) throw new Error('TREESEED_TEST_POSTGRES_URL is required; native terminal timeout coverage cannot be skipped.');
		const connection = new URL(url);
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
			await db.pool.query(`INSERT INTO capacity_execution_providers
				(id,capacity_provider_id,display_name,adapter,native_unit,max_concurrent_runners,created_at,updated_at)
				VALUES ('codex','provider','Codex','codex','seconds',1,$1,$1)`, [now]);
			await db.pool.query(`INSERT INTO capacity_provider_assignments
				(id,membership_id,team_id,project_id,capacity_provider_id,project_agent_class_id,mode,status,lease_state,
				lease_token,lease_expires_at,reservation_id,created_at,updated_at)
				VALUES ('assignment','membership','team','project','provider','engineer','acting','leased','leased','lease',$1,NULL,$2,$2)`, [expired, now]);
			await db.pool.query(`INSERT INTO capacity_reservations
				(id,idempotency_key,admission_token,membership_id,team_id,project_id,capacity_provider_id,project_agent_class_id,
				assignment_id,mode,requested_seconds,reserved_seconds,created_at,updated_at)
				VALUES ('reservation','reservation','admission','membership','team','project','provider','engineer','assignment','acting',$2,$2,$1,$1)`, [now, reservedSeconds]);
			await db.pool.query(`UPDATE capacity_provider_assignments SET reservation_id='reservation' WHERE id='assignment'`);
			await db.pool.query(`INSERT INTO capacity_admission_counters
				(id,team_id,scope,scope_id,period_key,hard_limit,committed_amount,created_at,updated_at)
				VALUES ('counter','team','model-day','terra','2026-09-16',$2,$2,$1,$1)`, [now, reservedSeconds]);
			await db.pool.query(`INSERT INTO capacity_reservation_counter_claims
				(reservation_id,counter_id,admission_token,reserved_amount,release_policy,created_at,updated_at)
				VALUES ('reservation','counter','admission',$2,'usage-settlement',$1,$1)`, [now, reservedSeconds]);
			if (phase) await seedPlanningBoundary(db, now, expired);
			else {
				const issuedAt = new Date(Date.parse(expired) - reservedSeconds * 1000).toISOString();
				const attempt = assignmentAttemptSchema.parse({ ...assignment, status: 'leased', createdAt: issuedAt, deadline: expired,
					estimate: { expectedSeconds: reservedSeconds, maximumSeconds: reservedSeconds },
					limits: { ...assignment.limits, maximumSeconds: reservedSeconds } });
				const budget = compileAssignmentTimeBudget({ now: issuedAt, requestedSeconds: reservedSeconds,
					configuredBudget: { deadline: expired } }).capacityBudget;
				await db.pool.query(`UPDATE capacity_provider_assignments SET assignment_attempt_json=$1,capacity_envelope_json=$2,
					execution_provider_id=$3,work_day_id=$4,execution_node_id=$5,execution_node_revision=$6,
					graph_revision=$7,attempt_count=$8,created_at=$9 WHERE id='assignment'`, [JSON.stringify(attempt),
					JSON.stringify({ teamId: 'team', projectId: 'project', workDayId: attempt.workdayId, mode: 'acting',
						projectAgentClassId: 'engineer', capacityProviderId: 'provider', executionProviderId: attempt.provider.executionProviderId,
						reservationId: 'reservation', budget }), attempt.provider.executionProviderId, attempt.workdayId, attempt.nodeId,
					attempt.nodeRevision, attempt.graphRevision, attempt.attempt, issuedAt]);
			}
			await db.pool.query(`UPDATE capacity_reservations SET work_day_id='workday',execution_provider_id='codex' WHERE id='reservation'`);
			const stored = (await db.pool.query<{ assignment_attempt_json: string }>(
				"SELECT assignment_attempt_json FROM capacity_provider_assignments WHERE id='assignment'")).rows;
			expect(stored).toHaveLength(1);
			const issued = assignmentAttemptSchema.parse(JSON.parse(stored[0]!.assignment_attempt_json));
			expect(issued.deadline).toBe(expired); expect(issued.limits.maximumSeconds).toBe(reservedSeconds);
			await db.pool.query(`INSERT INTO execution_nodes
				(id,team_id,project_id,workday_id,work_item_id,kind,pair_role,source_ref_json,authority_refs_json,
				rule_revision,node_revision,agent_class,status,graph_revision_created,graph_revision_updated,created_at,updated_at,
				estimate_json,required_capabilities_json,requested_permissions_json,workspace,acceptance_criteria_json,maximum_review_cycles)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,'running',1,$12,$13,$13,$14,$15,$16,$17,$18,2)`,
				[issued.nodeId, issued.teamId, issued.projectId, issued.workdayId, issued.workItemId, phase ? 'planning' : 'acting',
					phase ? null : 'actor', JSON.stringify(issued.sourceRef), JSON.stringify(issued.authorityRefs),
					issued.nodeRevision, issued.agentClass, issued.graphRevision, issued.createdAt, JSON.stringify(issued.estimate),
					JSON.stringify(issued.requiredCapabilities), JSON.stringify(issued.effectiveProfile.permissionCeiling),
					issued.workspace.mode, JSON.stringify(issued.acceptanceCriteria)]);
			if (requested) await db.pool.query(`UPDATE capacity_provider_assignments SET metadata_json='{"cancellationRequested":true}' WHERE id='assignment'`);
			const host = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, db);
			host.initializationPromise = Promise.resolve();
			const store = createCapacityControlPlane(host);
			const repository = new ProviderAssignmentRepository(store);
			const principal = { teamId: 'team', membershipId: 'membership', capacityProviderId: 'provider' };
			const failure = { leaseToken: 'lease', code: requested ? 'assignment_cancelled' : 'assignment_timeout', retryable: false,
				activeSeconds, elapsedSeconds: activeSeconds + 3, usage: { inputTokens: 200, outputTokens: 30 },
				output: { teardown: { verified: true, completedAt: now } } };
			const report = phase ? { ...failure, performance: terminalPerformance((await repository.get('team', 'assignment'))!, failure, 'failed', now) } : failure;
			expect(await store.completeProviderAssignment(principal, 'assignment', { leaseToken: 'lease' })).toBeNull();
			expect(await store.failProviderAssignment(principal, 'assignment', { ...failure, leaseToken: 'wrong' })).toBeNull();
			if (returned) {
				await settleCapacityReservationExactlyOnce(store, { settlementKey: 'pre-model-return', teamId: 'team',
					membershipId: 'membership', reservationId: 'reservation', assignmentId: 'assignment', activeSeconds,
					elapsedSeconds: activeSeconds + 3, usageActual: failure.usage, source: 'provider_assignment_return', existingSettlementPolicy: 'replay' });
				await db.pool.query(`UPDATE capacity_provider_assignments SET status='returned',lease_state='released',lease_token=NULL,
					lifecycle_output_json=$1 WHERE id='assignment'`, [JSON.stringify({ teardown: failure.output.teardown })]);
				const operator = new OperatorAssignmentService(store);
				await operator.cancel('team', 'assignment', { idempotencyKey: 'phase' });
				await operator.cancel('team', 'assignment', { idempotencyKey: 'phase-replay' });
			} else {
				const outcomes = await Promise.all([store.failProviderAssignment(principal, 'assignment', report), store.failProviderAssignment(principal, 'assignment', report)]);
				expect(outcomes.filter(Boolean)).toHaveLength(1);
			}
			expect(await repository.get('team', 'assignment')).toMatchObject({ status: phase ? 'cancelled' : 'failed',
				lifecycleOutput: { teardown: { verified: true, completedAt: now },
					performance: { disposition: phase ? 'cancelled' : 'deadline_exhausted',
						actual: { activeSeconds, elapsedSeconds: activeSeconds + 3, inputTokens: 200, outputTokens: 30 } } } });
			const reservation = await store.first('SELECT state,active_seconds,released_seconds FROM capacity_reservations WHERE id=?', ['reservation']);
			expect(reservation).toMatchObject({ state: 'consumed', active_seconds: activeSeconds, released_seconds: Math.max(0, reservedSeconds - activeSeconds) });
			expect(await store.first('SELECT hard_limit,committed_amount FROM capacity_admission_counters WHERE id=?', ['counter']))
				.toMatchObject({ hard_limit: reservedSeconds, committed_amount: activeSeconds });
			if (activeSeconds > reservedSeconds) expect(await store.first(
				'UPDATE capacity_admission_counters SET committed_amount=committed_amount+1 WHERE id=? AND committed_amount+1<=hard_limit RETURNING id', ['counter']))
				.toBeNull();
			const usages = await store.all('SELECT active_seconds,input_tokens,output_tokens FROM capacity_usage_actuals WHERE assignment_id=?', ['assignment']);
			expect(usages).toHaveLength(1);
			expect(usages[0]).toMatchObject({ active_seconds: activeSeconds, input_tokens: 200, output_tokens: 30 });
			expect(await store.all("SELECT id FROM capacity_ledger_entries WHERE phase='overrun_hold'")).toHaveLength(0);
		} finally {
			await db.close(); await admin.query(`DROP DATABASE "${name}"`); await admin.end();
		}
	}, 30_000);
});
