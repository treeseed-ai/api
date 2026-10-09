import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { assignmentAttemptSchema, calculateAssignmentAllocation } from '@treeseed/sdk/agent-capacity';
import { createControlPlanePostgresDatabase } from '../../../../../../src/api/support/control-plane-postgres.ts';
import { admitLivingExecutionAssignment } from '../../../../../../src/api/capacity/services/capacity/assignments/admission/living-execution-admission.ts';
import { assignment } from '../fixtures/assignment.ts';
import { ProviderAssignmentRepository } from '../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import { buildProviderAssignmentExplanation } from '../../../../../../src/api/capacity/services/capacity/assignments/observability/assignment-explanation-service.ts';
import { settleCapacityReservationExactlyOnce } from '../../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts';
import { ControlPlaneStore } from '../../../../../../src/api/persistence/store.ts';
import { CapacityReservationRepository } from '../../../../../../src/api/capacity/repositories/capacity/accounting/reservation.ts';
import { CapacityLedgerRepository } from '../../../../../../src/api/capacity/repositories/capacity/accounting/ledger.ts';
import { listTaskUsageActualsPage } from '../../../../../../src/api/capacity/repositories/capacity/accounting/task-usage.ts';

const url = process.env.TREESEED_TEST_POSTGRES_URL;
describe('living admission in disposable PostgreSQL', () => {
	it('serializes competing claims and rolls back without orphan reservations or duplicate charges', async () => {
		if (!url) throw new Error('TREESEED_TEST_POSTGRES_URL is required; native atomic admission coverage cannot be skipped.');
		const connection = new URL(url);
		if (connection.hostname !== '127.0.0.1' || connection.pathname !== '/postgres') throw new Error('Explicit disposable loopback PostgreSQL required.');
		const admin = new pg.Pool({ connectionString: connection.href });
		const name = `treeseed_allocation_test_${randomUUID().replaceAll('-', '')}`;
		await admin.query(`CREATE DATABASE "${name}"`);
		connection.pathname = `/${name}`;
		const database = createControlPlanePostgresDatabase(connection.href, { migrationMode: 'apply' });
		let peer: ReturnType<typeof createControlPlanePostgresDatabase> | undefined;
		try {
			await database.migrate();
			peer = createControlPlanePostgresDatabase(connection.href);
			const peerDatabase = peer;
			const accounting = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, database);
			const peerAccounting = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, peerDatabase);
			// Original full migrations above own initialization; don't seed an
			// unrelated portfolio while reading this freshly allocated database.
			accounting.initializationPromise = peerAccounting.initializationPromise = Promise.resolve();
			const connections = await Promise.all([database, peerDatabase].map(owner => owner.pool.query('SELECT pg_backend_pid() AS pid,current_database() AS name')));
			expect(connections.map(result => result.rows[0].name)).toEqual([name, name]);
			expect(connections[0]!.rows[0].pid).not.toBe(connections[1]!.rows[0].pid);
			const now = assignment.createdAt;
			await database.pool.query(`INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ('team','team','Team',$1,$1)`, [now]);
			await database.pool.query(`INSERT INTO capacity_workday_runs (id,team_id,status,execution_mode,created_at,updated_at)
				VALUES ('workday','team','running','simulation',$1,$1)`, [now]);
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
			let staleAdmissionRead = false;
			const store = { ensureInitialized: () => database.migrate(),
				run: async (sql: string, params: unknown[] = []) => { await database.prepare(sql).bind(...params).run(); },
				first: (sql: string, params: unknown[] = []) => database.prepare(sql).bind(...params).first(),
				all: async (sql: string, params: unknown[] = []) => (await database.prepare(sql).bind(...params).all()).results,
				batch: (operations: Array<{ query: string; params?: unknown[] }>) => database.batch(operations),
				getProviderAssignment: (team: string, id: string): ReturnType<ProviderAssignmentRepository['get']> => {
					if (staleAdmissionRead) { staleAdmissionRead = false; return Promise.resolve(null); }
					return new ProviderAssignmentRepository(store as never).get(team, id);
				},
			};
			const attempts = ['first', 'second'].map(id => assignmentAttemptSchema.parse({ ...assignment,
				id, idempotencyKey: id, nodeId: id, reservationId: `reservation-${id}` }));
			for (const attempt of attempts) await database.prepare(`INSERT INTO execution_nodes
				(id,team_id,project_id,workday_id,kind,source_ref_json,authority_refs_json,rule_revision,node_revision,agent_class,status,
				graph_revision_created,graph_revision_updated,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,1,'engineer','ready',1,2,?,?)`)
				.bind(attempt.nodeId, attempt.teamId, attempt.projectId, attempt.workdayId, 'acting',
					JSON.stringify(attempt.sourceRef), JSON.stringify(attempt.authorityRefs), attempt.createdAt, attempt.createdAt).run();
			const run = (attempt: typeof attempts[number], owner: Parameters<typeof admitLivingExecutionAssignment>[0] = store as never) => admitLivingExecutionAssignment(owner, {
				principal: { teamId: 'team', capacityProviderId: 'provider', membershipId: 'membership' } as never,
				assignment: attempt, allocation: { ...calculateAssignmentAllocation({ estimate: attempt.estimate, measurements: [],
					constraints: [{ id: 'model-day', remainingSeconds: 3 }] }),
					// Direct-admission fixture: production obtains this phase from the workday allocator.
					opportunity: { phase: 'acting' } } as never,
				accountingLimits: { modelConfigurationId: 'terra-medium', dailyActiveSecondsLimit: 10, capabilityLimits: { 'code-change': { dailyActiveSecondsLimit: 10 } } },
				projectAgentClassId: 'class', providerSessionId: 'session', executionProviderId: 'codex', laneId: 'workday', lanePurpose: 'workday',
				executionKind: 'workday', workdayConcurrencyLimit: 1, predecessorResults: [], treedxProxyHandle: { id: `tdx-${attempt.id}` }, now: attempt.createdAt,
			});
			const results = await Promise.allSettled(attempts.map((attempt, index) => run(attempt, index === 0 ? store as never : peerAccounting)));
			expect(results.filter(result => result.status === 'fulfilled'), results.map(result => result.status === 'rejected' ? String(result.reason) : 'admitted').join('\n')).toHaveLength(1);
			const counters = await database.pool.query('SELECT committed_amount FROM capacity_admission_counters');
			expect(counters.rows).toEqual([{ committed_amount: 4 }, { committed_amount: 4 }]);
			expect((await database.pool.query('SELECT count(*)::int AS count FROM capacity_reservations')).rows[0].count).toBe(1);
			const winner = attempts[results.findIndex(result => result.status === 'fulfilled')]!;
			await run(winner);
			const nativeIssuance = await peerDatabase.pool.query(`SELECT node.id AS node_id,node.status,
				assignment.id AS assignment_id,reservation.id AS reservation_id,assignment.assignment_attempt_json::jsonb AS authority,
				assignment.lease_state,assignment.execution_node_revision,assignment.graph_revision
				FROM execution_nodes node LEFT JOIN capacity_provider_assignments assignment ON assignment.execution_node_id=node.id
				LEFT JOIN capacity_reservations reservation ON reservation.id=assignment.reservation_id AND reservation.assignment_id=assignment.id
				WHERE node.workday_id='workday' ORDER BY node.id`);
			expect(nativeIssuance.rows).toEqual(attempts.map(attempt => attempt.id === winner.id
				? { node_id: attempt.nodeId, status: 'assigned', assignment_id: attempt.id, reservation_id: attempt.reservationId,
					authority: attempt, lease_state: 'unleased', execution_node_revision: attempt.nodeRevision, graph_revision: attempt.graphRevision }
				: { node_id: attempt.nodeId, status: 'ready', assignment_id: null, reservation_id: null, authority: null,
					lease_state: null, execution_node_revision: null, graph_revision: null }));
			const publicInventory = async () => {
				const [assignments, reservations, usage, ledger] = await Promise.all([
					new ProviderAssignmentRepository(peerAccounting).list('team', { workdayId: 'workday', limit: 1 }),
					new CapacityReservationRepository(peerAccounting).listProjectPage('project', { workDayId: 'workday', limit: 1 }),
					listTaskUsageActualsPage(peerAccounting, 'project', { workDayId: 'workday', limit: 1 }),
					new CapacityLedgerRepository(peerAccounting).listProjectPage('project', { workDayId: 'workday', limit: 1 }),
				]);
				for (const page of [assignments, reservations, usage, ledger]) expect(page.page).toEqual({ limit: 1, hasMore: false, nextCursor: null });
				return { assignments: assignments.items, reservations: reservations.items, usage: usage.items, ledger: ledger.items };
			};
			const issuedPublic = await publicInventory();
			expect(issuedPublic.assignments.map(value => value.assignmentAttempt)).toEqual([winner]);
			expect(issuedPublic.reservations).toMatchObject([{ id: winner.reservationId, assignmentId: winner.id, state: 'reserved',
				teamId: winner.teamId, projectId: winner.projectId, workDayId: winner.workdayId, reservedSeconds: winner.limits.maximumSeconds }]);
			expect(issuedPublic.reservations).toHaveLength(1); expect(issuedPublic.usage).toEqual([]); expect(issuedPublic.ledger).toEqual([]);
			expect((await new ProviderAssignmentRepository(peerAccounting).list('other-team', { workdayId: 'workday' })).items).toEqual([]);
			expect((await new ProviderAssignmentRepository(peerAccounting).list('team', { workdayId: 'other-workday' })).items).toEqual([]);
			// Both admissions observed absence, but the winner committed and was
			// leased/pinned before the losing SQL batch acquired the workday lock.
			const custody = { sourceWorkspace: { exactCommit: 'a'.repeat(40) }, retained: 'winner' };
			await database.pool.query(`UPDATE capacity_provider_assignments SET status='leased',lease_state='leased',
				workspace_context_json=$1 WHERE id=$2`, [JSON.stringify(custody), winner.id]);
			staleAdmissionRead = true;
			await run(winner);
			expect((await database.pool.query('SELECT workspace_context_json::jsonb AS context FROM capacity_provider_assignments WHERE id=$1', [winner.id])).rows[0].context)
				.toEqual(custody);
			await database.pool.query(`UPDATE capacity_provider_assignments SET status='pending',lease_state='unleased' WHERE id=$1`, [winner.id]);
			const admitted = await new ProviderAssignmentRepository(store as never).get('team', winner.id);
			if (!admitted?.assignmentAttempt) throw new Error('Complete admitted assignment authority is required for the settlement fixture.');
			expect(admitted?.explanation)
				.toMatchObject({ metadata: { allocation: { admitted: true } } });
			expect(buildProviderAssignmentExplanation(admitted!, 'team', { source: 'lease_next_assignment', eligible: true }, now))
				.toMatchObject({ metadata: { allocation: { admitted: true } } });
			expect((await database.pool.query('SELECT sum(reserved_amount)::int AS total FROM capacity_reservation_counter_claims')).rows[0].total).toBe(6);
			// Terminal overuse is retained as measured truth, never approved by raising
			// the cap. The real admission path must deny additional work atomically.
			await database.pool.query('UPDATE capacity_admission_counters SET committed_amount=11');
			const loser = attempts[results.findIndex(result => result.status === 'rejected')]!;
			await expect(run(loser)).rejects.toMatchObject({ code: 'capacity_assignment_allocation_deferred' });
			expect((await database.pool.query('SELECT hard_limit,committed_amount FROM capacity_admission_counters')).rows)
				.toEqual([{ hard_limit: 10, committed_amount: 11 }, { hard_limit: 10, committed_amount: 11 }]);
			expect((await database.pool.query('SELECT count(*)::int AS count FROM capacity_reservations')).rows[0].count).toBe(1);
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
			await database.pool.query(`UPDATE capacity_provider_assignments SET assignment_attempt_json='not-json' WHERE id=$1`, [winner.id]);
			await expect(repository.get('team', winner.id)).rejects.toThrow('invalid assignment_attempt_json');
			expect(await repository.getForCancellation('team', winner.id)).toMatchObject({ id: winner.id,
				assignmentAttempt: null, explanation: { snapshotValidation: { valid: false, field: 'assignment_attempt_json' } } });
			// Restore the exact owning admission read-back, not an empty noncanonical attempt.
			await database.pool.query(`UPDATE capacity_provider_assignments SET assignment_attempt_json=$1 WHERE id=$2`,
				[JSON.stringify(admitted.assignmentAttempt), winner.id]);
			const settlement = { settlementKey: `settle:${winner.id}`, teamId: 'team', membershipId: 'membership',
				reservationId: winner.reservationId, assignmentId: winner.id, activeSeconds: 2, elapsedSeconds: 4,
				providerUnits: 0.25, usd: 0.001, usageActual: { inputTokens: 7, outputTokens: 3, nativeUsage: { tokens: 10, providerSeconds: 0.25 } },
				source: 'postgres-admission-test' };
			const originalSettlement = structuredClone(settlement);
			const state = async (reader = database) => ({
				assignments: (await reader.pool.query('SELECT * FROM capacity_provider_assignments ORDER BY id')).rows,
				reservations: (await reader.pool.query('SELECT * FROM capacity_reservations ORDER BY id')).rows,
				proxies: (await reader.pool.query('SELECT * FROM treedx_proxy_handles ORDER BY id')).rows,
				counters: (await reader.pool.query('SELECT * FROM capacity_admission_counters ORDER BY id')).rows,
				claims: (await reader.pool.query('SELECT * FROM capacity_reservation_counter_claims ORDER BY reservation_id,counter_id')).rows,
				usage: (await reader.pool.query('SELECT * FROM capacity_usage_actuals ORDER BY id')).rows,
				ledger: (await reader.pool.query('SELECT * FROM capacity_ledger_entries ORDER BY id')).rows,
				nodes: (await reader.pool.query('SELECT * FROM execution_nodes ORDER BY id')).rows,
			});
			const beforeFailure = await state(); expect(await state(peerDatabase)).toEqual(beforeFailure);
			const publicBeforeFailure = await publicInventory();
			// Last-write failure in the SAME allocated native database: original
			// usage/counter adjustments have been attempted, and must roll back.
			await database.pool.query(`CREATE FUNCTION admission_settlement_failure() RETURNS trigger LANGUAGE plpgsql AS
				$$ BEGIN RAISE EXCEPTION 'original native terminal ledger interruption'; END $$`);
			await database.pool.query(`CREATE TRIGGER admission_settlement_failure BEFORE INSERT ON capacity_ledger_entries
				FOR EACH ROW EXECUTE FUNCTION admission_settlement_failure()`);
			await expect(settleCapacityReservationExactlyOnce(accounting, settlement)).rejects.toMatchObject({ code: 'P0001' });
			expect(await state()).toEqual(beforeFailure); expect(await state(peerDatabase)).toEqual(beforeFailure);
			expect(await publicInventory()).toEqual(publicBeforeFailure);
			expect(settlement).toEqual(originalSettlement);
			await database.pool.query('DROP TRIGGER admission_settlement_failure ON capacity_ledger_entries');
			await database.pool.query('DROP FUNCTION admission_settlement_failure()');
			expect((await peerDatabase.pool.query("SELECT tgname FROM pg_trigger WHERE tgname='admission_settlement_failure' AND tgrelid='capacity_ledger_entries'::regclass")).rows).toEqual([]);
			expect((await peerDatabase.pool.query("SELECT proname FROM pg_proc WHERE proname='admission_settlement_failure' AND pronamespace='public'::regnamespace")).rows).toEqual([]);
			expect(await state()).toEqual(beforeFailure);
			const settled = await Promise.all([
				settleCapacityReservationExactlyOnce(accounting, settlement),
				settleCapacityReservationExactlyOnce(peerAccounting, structuredClone(settlement)),
			]);
			expect(settled.map(value => value.replayed).sort()).toEqual([false, true]);
			expect(settled[0]!.entry).toEqual(settled[1]!.entry);
			expect(settled[0]!.usageActualId).toBe(settled[1]!.usageActualId);
			const retained = await state(); expect(await state(peerDatabase)).toEqual(retained);
			expect(retained.usage).toHaveLength(1); expect(retained.ledger).toHaveLength(1);
			expect(retained.reservations).toHaveLength(1); expect(retained.reservations[0]).toMatchObject({ state: 'consumed', active_seconds: 2, elapsed_seconds: 4 });
			expect(retained.counters.map(counter => counter.committed_amount)).toEqual([10, 10]);
			expect(retained.assignments).toEqual(beforeFailure.assignments); expect(retained.nodes).toEqual(beforeFailure.nodes); expect(retained.proxies).toEqual(beforeFailure.proxies);
			expect(JSON.parse(String(retained.usage[0]!.native_usage_json))).toEqual(settlement.usageActual.nativeUsage);
			const published = await publicInventory();
			expect(published.assignments.map(value => value.id)).toEqual(retained.assignments.map(value => value.id));
			expect(published.assignments.map(value => value.assignmentAttempt)).toEqual([winner]);
			expect(published.reservations.map(value => value.id)).toEqual(retained.reservations.map(value => value.id));
			expect(published.reservations[0]).toMatchObject({ assignmentId: winner.id, state: 'consumed', activeSeconds: 2, elapsedSeconds: 4,
				consumedProviderUnits: 0.25, consumedUsd: 0.001 });
			expect(published.usage.map(value => value.id)).toEqual(retained.usage.map(value => value.id));
			expect(published.usage[0]).toMatchObject({ assignmentId: winner.id, assignmentAttempt: winner.attempt, workDayId: winner.workdayId,
				accountingMode: 'aggregate', activeSeconds: 2, elapsedSeconds: 4, inputTokens: 7, outputTokens: 3, nativeUsage: settlement.usageActual.nativeUsage });
			expect(published.ledger.map(value => value.id)).toEqual(retained.ledger.map(value => value.id));
			expect(published.ledger).toEqual([settled[0]!.entry]);
			expect(published.ledger[0]!.usageSettlement).toMatchObject({ assignmentId: winner.id, reservationId: winner.reservationId,
				actualSeconds: 2, idempotencyKey: settlement.settlementKey, teamId: winner.teamId, projectId: winner.projectId, workdayId: winner.workdayId });
			for (const change of [{ activeSeconds: 3 }, { elapsedSeconds: 5 }, { providerUnits: 0.5 }, { usd: 0.002 },
				{ usageActual: { ...settlement.usageActual, nativeUsage: { tokens: 11, providerSeconds: 0.25 } } }]) {
				const changed = { ...settlement, ...change }, unchanged = structuredClone(changed);
				await expect(settleCapacityReservationExactlyOnce(peerAccounting, changed)).rejects.toMatchObject({ status: 409 });
				expect(await state()).toEqual(retained); expect(await state(peerDatabase)).toEqual(retained); expect(changed).toEqual(unchanged);
			}
			// Preserve the original first-commit false and exact replay true
			// assertions without prescribing which native pool wins the race.
			expect(settled.find(value => value.replayed === false)?.replayed).toBe(false);
			expect((await settleCapacityReservationExactlyOnce(store as never, settlement)).replayed).toBe(true);
			expect(await state()).toEqual(retained); expect(await state(peerDatabase)).toEqual(retained); expect(settlement).toEqual(originalSettlement);
			expect(await publicInventory()).toEqual(published);
			expect((await database.pool.query(`SELECT count(*)::int AS count FROM capacity_ledger_entries
				WHERE reservation_id=$1 AND phase='task_completed_actual_settlement'`, [winner.reservationId])).rows[0].count).toBe(1);
			expect((await database.pool.query(`SELECT count(*)::int AS count FROM capacity_usage_actuals
				WHERE assignment_id=$1 AND accounting_mode='aggregate'`, [winner.id])).rows[0].count).toBe(1);
		} finally {
			try { await Promise.all([database.close(), ...(peer ? [peer.close()] : [])]); }
			finally { try { await admin.query(`DROP DATABASE "${name}"`); } finally { await admin.end(); } }
		}
	}, 30_000);
});
