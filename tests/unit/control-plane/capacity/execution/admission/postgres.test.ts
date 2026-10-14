import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { appliedWorkdaySchema, assignmentAttemptSchema, calculateAssignmentAllocation, compileWorkday, DEFAULT_WORKDAY_POLICY } from '@treeseed/sdk/agent-capacity';
import { createControlPlanePostgresDatabase } from '../../../../../../src/api/support/control-plane-postgres.ts';
import { admitLivingExecutionAssignment } from '../../../../../../src/api/capacity/services/capacity/assignments/admission/living-execution-admission.ts';
import { assignment } from '../fixtures/assignment.ts';
import { proveNativeLeaseClaim } from './native-lease-claim.ts';
import { ProviderAssignmentRepository } from '../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import { buildProviderAssignmentExplanation } from '../../../../../../src/api/capacity/services/capacity/assignments/observability/assignment-explanation-service.ts';
import { settleCapacityReservationExactlyOnce } from '../../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts';
import { ControlPlaneStore } from '../../../../../../src/api/persistence/store.ts';
import { CapacityReservationRepository } from '../../../../../../src/api/capacity/repositories/capacity/accounting/reservation.ts';
import { CapacityLedgerRepository } from '../../../../../../src/api/capacity/repositories/capacity/accounting/ledger.ts';
import { listTaskUsageActualsPage } from '../../../../../../src/api/capacity/repositories/capacity/accounting/task-usage.ts';
import { decodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { requireNativeAdmissionSamples, verifyNativeInventory, verifyNativeAssignmentReadback, verifyNativeSettlementReadback, verifyNativeModelExecutionInventory, verifyNativeWorkdayReadback } from '../../../../../acceptance/execution-inventory.ts';
import { createWorkdayProfileService } from '../../../../../../src/api/control-plane/repositories/capacity/workdays/profile-service.ts';
import { CapacityWorkdayEventRepository } from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';
import { createDiagnosticEnvelopeService } from '../../../../../../src/security/diagnostic-envelope.ts';
import { CapacityWorkdayRunRepository } from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-run.ts';

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
			// Freeze one current fixture before admission; preserve the original authority interval and all execution/watchdog limits.
			const now = new Date().toISOString();
			const currentAssignment = { ...assignment, createdAt: now,
				deadline: new Date(Date.parse(now) + Date.parse(assignment.deadline) - Date.parse(assignment.createdAt)).toISOString() };
			await database.pool.query(`INSERT INTO teams (id,slug,name,created_at,updated_at)
				VALUES ('team','team','Team',$1,$1),('foreign-team','foreign-team','Foreign Team',$1,$1)`, [now]);
			await database.pool.query(`INSERT INTO capacity_workday_runs (id,team_id,status,execution_mode,created_at,updated_at)
				VALUES ('workday','team','running','simulation',$1,$1)`, [now]);
			const originalPlan = compileWorkday({ id: 'workday', teamId: 'team', policyId: 'default', policyRevision: 1,
				executionMode: 'simulation', startsAt: now, agentIds: [], policy: DEFAULT_WORKDAY_POLICY });
			await database.pool.query('UPDATE capacity_workday_runs SET parameters_json=$1 WHERE id=$2', [JSON.stringify({
				...originalPlan.policySnapshot, policyId: 'default', profileId: 'default', policyRevision: 1, appliedPlan: originalPlan }), 'workday']);
			await database.pool.query(`INSERT INTO projects (id,team_id,slug,name,created_at,updated_at) VALUES ('project','team','project','Project',$1,$1)`, [now]);
			await database.pool.query(`INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,created_at,updated_at) VALUES ('class','team','project','engineer','Engineer',$1,$1)`, [now]);
			await database.pool.query(`INSERT INTO capacity_providers (id,fingerprint,public_jwk_json,display_name,created_at,updated_at) VALUES ('provider','test','{}','Provider',$1,$1)`, [now]);
			await database.pool.query(`INSERT INTO capacity_provider_team_memberships (id,team_id,capacity_provider_id,approved_at,approved_by_id,created_at,updated_at) VALUES ('membership','team','provider',$1,'test',$1,$1)`, [now]);
			await database.pool.query(`INSERT INTO capacity_execution_providers (id,capacity_provider_id,display_name,adapter,native_unit,max_concurrent_runners,created_at,updated_at) VALUES ('codex','provider','Codex','codex','seconds',1,$1,$1)`, [now]);
			await database.pool.query(`INSERT INTO capacity_provider_lanes (id,capacity_provider_id,execution_provider_id,display_name,purpose,max_concurrent_runners,created_at,updated_at) VALUES ('workday','provider','codex','Workday','workday',1,$1,$1)`, [now]);
			await database.pool.query(`INSERT INTO capacity_provider_availability_sessions
				(id,membership_id,team_id,capacity_provider_id,opened_at,refreshed_at,expires_at,available_from,created_at,updated_at)
				VALUES ('session','membership','team','provider',$1,$1,$2,$1,$1,$1)`, [now, currentAssignment.deadline]);
			const observed = { day: now.slice(0, 10), observedAt: now, healthy: true, activeSeconds: 1, reservedSeconds: 0 };
			await database.pool.query(`UPDATE capacity_provider_availability_sessions SET execution_providers_json=$1 WHERE id='session'`,
				[JSON.stringify([{ id: 'codex', runtimeBuild: assignment.provider.runtimeBuild, status: 'available', capabilities: [],
					maxConcurrentRunners: 1, lanes: [{ id: 'workday', purpose: 'workday', maxConcurrentRunners: 1 }], nativeLimits: { modelConfigurationId: 'terra-medium' },
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
			const attempts = ['first', 'second'].map(id => assignmentAttemptSchema.parse({ ...currentAssignment,
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
				const [nativeAssignments, nativeReservations, nativeUsage, nativeLedger] = await Promise.all([
					'capacity_provider_assignments', 'capacity_reservations', 'capacity_usage_actuals', 'capacity_ledger_entries',
				].map(table => peerDatabase.pool.query(`SELECT * FROM ${table} WHERE work_day_id=$1 AND project_id=$2`, ['workday', 'project'])));
				const [assignments, reservations, usage, ledger] = await Promise.all([
					verifyNativeInventory(nativeAssignments!.rows, cursor => new ProviderAssignmentRepository(peerAccounting)
						.list('team', { workdayId: 'workday', limit: 1, cursor: decodeCapacityPageCursor(cursor) }), 1),
					verifyNativeInventory(nativeReservations!.rows, cursor => new CapacityReservationRepository(peerAccounting)
						.listProjectPage('project', { workDayId: 'workday', limit: 1, cursor: decodeCapacityPageCursor(cursor) }), 1),
					verifyNativeInventory(nativeUsage!.rows, cursor => listTaskUsageActualsPage(peerAccounting, 'project',
						{ workDayId: 'workday', limit: 1, cursor: decodeCapacityPageCursor(cursor) }), 1),
					verifyNativeInventory(nativeLedger!.rows, cursor => new CapacityLedgerRepository(peerAccounting)
						.listProjectPage('project', { workDayId: 'workday', limit: 1, cursor: decodeCapacityPageCursor(cursor) }), 1),
				]);
				for (const native of nativeAssignments!.rows) verifyNativeAssignmentReadback(native,
					assignments.find(value => value.id === native.id)!, { id: 'workday', teamId: 'team' }, nativeReservations!.rows, nativeAssignments!.rows);
				for (const native of nativeAssignments!.rows) {
					const visible = assignments.find(value => value.id === native.id)!;
					const original = structuredClone(visible);
					for (const changed of [{ ...visible, laneId: 'substituted-lane' }, { ...visible, lanePurpose: 'communication' }])
						expect(() => verifyNativeAssignmentReadback(native, changed, { id: 'workday', teamId: 'team' }, nativeReservations!.rows, nativeAssignments!.rows)).toThrow('ACCEPTANCE_NATIVE_LANE');
					expect(visible).toEqual(original);
				}
				const workday = await new CapacityWorkdayRunRepository(peerAccounting).get('team', 'workday');
				if (!workday) throw new Error('Original native workday admission projection required.');
				const shares = (await peerDatabase.pool.query(`SELECT project_id,assignment_attempt_json::jsonb->>'agentClass' AS agent_class,
					SUM((assignment_attempt_json::jsonb->'limits'->>'maximumSeconds')::numeric) AS admitted_seconds
					FROM capacity_provider_assignments WHERE team_id=$1 AND work_day_id=$2
					GROUP BY project_id,assignment_attempt_json::jsonb->>'agentClass'`, ['team', 'workday'])).rows;
				const nativeRun = (await peerDatabase.pool.query('SELECT * FROM capacity_workday_runs WHERE team_id=$1 AND id=$2', ['team', 'workday'])).rows;
				verifyNativeWorkdayReadback(nativeRun, workday, shares);
				return { assignments, reservations, usage, ledger, workday, shares };
			};
			const issuedPublic = await publicInventory();
			const nativeRun = (await peerDatabase.pool.query('SELECT * FROM capacity_workday_runs WHERE team_id=$1 AND id=$2', ['team', 'workday'])).rows;
			const nativeAssignment = (await peerDatabase.pool.query('SELECT * FROM capacity_provider_assignments WHERE id=$1', [winner.id])).rows[0]!;
			const nativeReservations = (await peerDatabase.pool.query('SELECT * FROM capacity_reservations WHERE work_day_id=$1', ['workday'])).rows;
			const originalAdmission = structuredClone({ issuedPublic, nativeRun, nativeAssignment, nativeReservations });
			// Corrupt only the disposable owning database; inspect through an independent connection and original public serializer.
			const fakeId = 'controlled-cohort-assignment', fakeReservation = 'controlled-cohort-reservation';
			const other = attempts.find(value => value.id !== winner.id)!;
			const fakeAttempt = { ...winner, id: fakeId, idempotencyKey: fakeId, nodeId: other.nodeId, reservationId: fakeReservation };
			const inspectCohort = async () => {
				const owners = (await peerDatabase.pool.query('SELECT * FROM capacity_provider_assignments WHERE work_day_id=$1 ORDER BY id', ['workday'])).rows;
				const reserved = (await peerDatabase.pool.query('SELECT * FROM capacity_reservations WHERE work_day_id=$1 ORDER BY id', ['workday'])).rows;
				const visible = await new ProviderAssignmentRepository(peerAccounting).get('team', winner.id); if (!visible) throw new Error('Original public owner required');
				verifyNativeAssignmentReadback(owners.find(value => value.id === winner.id)!, { ...visible }, { id: 'workday', teamId: 'team' }, reserved, owners);
				return { owners, reserved };
			};
			const originalCohort = await inspectCohort(), failedCohorts: unknown[] = [];
			for (const mode of ['orphan-reservation', 'duplicate-lease']) {
				const injectedReservation = { ...nativeReservations[0], id: fakeReservation, assignment_id: fakeId, idempotency_key: fakeId };
				const injectedAssignment = { ...nativeAssignment, id: fakeId, reservation_id: fakeReservation, execution_node_id: other.nodeId,
					assignment_attempt_json: JSON.stringify(fakeAttempt), synthesis_key: fakeId };
				try {
					await database.pool.query('INSERT INTO capacity_reservations SELECT (json_populate_record(NULL::capacity_reservations,$1::json)).*', [JSON.stringify(injectedReservation)]);
					if (mode === 'duplicate-lease') await database.pool.query('INSERT INTO capacity_provider_assignments SELECT (json_populate_record(NULL::capacity_provider_assignments,$1::json)).*', [JSON.stringify(injectedAssignment)]);
					const owners = (await peerDatabase.pool.query('SELECT * FROM capacity_provider_assignments WHERE work_day_id=$1 ORDER BY id', ['workday'])).rows;
					const reserved = (await peerDatabase.pool.query('SELECT * FROM capacity_reservations WHERE work_day_id=$1 ORDER BY id', ['workday'])).rows;
					const held = structuredClone({ mode, owners, reserved }); failedCohorts.push(held);
					await expect(inspectCohort()).rejects.toThrow('ACCEPTANCE_NATIVE_ISSUANCE');
					expect((await database.pool.query('SELECT * FROM capacity_provider_assignments WHERE work_day_id=$1 ORDER BY id', ['workday'])).rows).toEqual(held.owners);
					expect((await database.pool.query('SELECT * FROM capacity_reservations WHERE work_day_id=$1 ORDER BY id', ['workday'])).rows).toEqual(held.reserved);
				} finally {
					await database.pool.query('DELETE FROM capacity_provider_assignments WHERE id=$1', [fakeId]);
					await database.pool.query('DELETE FROM capacity_reservations WHERE id=$1', [fakeReservation]);
				}
				expect(await inspectCohort()).toEqual(originalCohort); expect(await publicInventory()).toEqual(issuedPublic);
			}
			expect(failedCohorts).toHaveLength(2);
			for (const seconds of [0, winner.limits.maximumSeconds - 1, winner.limits.maximumSeconds + 1]) {
				const denied = nativeReservations.map(row => ({ ...row, requested_seconds: seconds })), failed = structuredClone(denied);
				expect(() => verifyNativeAssignmentReadback(nativeAssignment, issuedPublic.assignments[0]!,
					{ id: 'workday', teamId: 'team' }, denied, [nativeAssignment])).toThrow('ACCEPTANCE_NATIVE_RESERVATION');
				expect(denied).toEqual(failed);
			}
			const plan = appliedWorkdaySchema.parse(issuedPublic.workday.parameters.appliedPlan);
			for (const changedPlan of [{ ...plan, admittedSecondsByProject: { project: 0 } },
				{ ...plan, admittedSecondsByAgentClass: { 'project:engineer': 0 } }]) {
				const denied = { ...issuedPublic.workday, parameters: { ...issuedPublic.workday.parameters, appliedPlan: changedPlan } };
				const failed = structuredClone(denied);
				expect(() => verifyNativeWorkdayReadback(nativeRun, denied, issuedPublic.shares)).toThrow('ACCEPTANCE_NATIVE_WORKDAY');
				expect(denied).toEqual(failed);
			}
			expect({ issuedPublic, nativeRun, nativeAssignment, nativeReservations }).toEqual(originalAdmission);
			expect(await Promise.all([publicInventory(), publicInventory()])).toEqual([issuedPublic, issuedPublic]);
			// Write controlled lifecycle bytes through one native connection and
			// read the actual owning public serializer through the independent peer.
			const lifecycleOutput = { sandboxId: 'controlled-native-sandbox', retained: { source: 'original-sql-row' } };
			await database.pool.query('UPDATE capacity_provider_assignments SET lifecycle_output_json=$1 WHERE id=$2', [JSON.stringify(lifecycleOutput), winner.id]);
			try {
				const observed = await publicInventory(); expect(observed.assignments[0]!.lifecycleOutput).toEqual(lifecycleOutput);
				const raw = (await peerDatabase.pool.query('SELECT * FROM capacity_provider_assignments WHERE id=$1', [winner.id])).rows[0]!;
				const reservations = (await peerDatabase.pool.query('SELECT * FROM capacity_reservations WHERE work_day_id=$1', ['workday'])).rows;
				const held = structuredClone({ raw, observed, reservations });
				for (const lifecycleOutput of [undefined, null, {}, { sandboxId: 'substituted-native-sandbox' }])
					expect(() => verifyNativeAssignmentReadback(raw, { ...observed.assignments[0], lifecycleOutput },
						{ id: 'workday', teamId: 'team' }, reservations, [raw])).toThrow('ACCEPTANCE_NATIVE_LIFECYCLE');
				expect(await Promise.all([publicInventory(), publicInventory()])).toEqual([observed, observed]);
				expect({ raw, observed, reservations }).toEqual(held);
				for (const malformed of ['{', 'null', '[]', 'true', '1']) {
					await database.pool.query('UPDATE capacity_provider_assignments SET lifecycle_output_json=$1 WHERE id=$2', [malformed, winner.id]);
					await expect(publicInventory()).rejects.toThrow();
					expect((await peerDatabase.pool.query('SELECT lifecycle_output_json FROM capacity_provider_assignments WHERE id=$1', [winner.id])).rows)
						.toEqual([{ lifecycle_output_json: malformed }]);
				}
			} finally { await database.pool.query("UPDATE capacity_provider_assignments SET lifecycle_output_json='{}' WHERE id=$1", [winner.id]); }
			expect(await publicInventory()).toEqual(issuedPublic);
			const deniedReservations: unknown[] = [];
			for (const [column, replacement, original] of [['team_id', 'foreign-team', winner.teamId],
				['reserved_seconds', winner.limits.maximumSeconds + 1, winner.limits.maximumSeconds]] as const) {
				await database.pool.query(`UPDATE capacity_reservations SET ${column}=$1 WHERE id=$2`, [replacement, winner.reservationId]);
				try {
					const observed = (await peerDatabase.pool.query('SELECT * FROM capacity_reservations WHERE id=$1', [winner.reservationId])).rows;
					deniedReservations.push(structuredClone(observed));
					await expect(publicInventory()).rejects.toThrow('ACCEPTANCE_NATIVE_RESERVATION');
					expect(observed).toEqual(deniedReservations.at(-1));
				} finally { await database.pool.query(`UPDATE capacity_reservations SET ${column}=$1 WHERE id=$2`, [original, winner.reservationId]); }
				expect(await publicInventory()).toEqual(issuedPublic);
			}
			expect(deniedReservations).toHaveLength(2);
			expect(issuedPublic.assignments.map(value => value.assignmentAttempt)).toEqual([winner]);
			// This direct native admission fixture has default priority and no
			// historical measurements. The separate architecture case retains its
			// additional sample minima; normal schema proof may genuinely cold-start.
			const explanation = issuedPublic.assignments[0]!.explanation as { metadata: { allocation: { calibration: { measurementIds: string[]; multiplier: number } } } };
			const cold = explanation.metadata;
			expect(cold.allocation.calibration.measurementIds).toEqual([]);
			expect(cold.allocation.calibration.multiplier).toBe(winner.estimate.maximumSeconds / winner.estimate.expectedSeconds);
			expect(() => requireNativeAdmissionSamples(0, cold.allocation.calibration.measurementIds.length, false)).not.toThrow();
			expect(() => requireNativeAdmissionSamples(0, cold.allocation.calibration.measurementIds.length)).toThrow('ACCEPTANCE_PRIORITY_EMPTY');
			expect(await Promise.all([publicInventory(), publicInventory()])).toEqual([issuedPublic, issuedPublic]);
			expect(issuedPublic.reservations).toMatchObject([{ id: winner.reservationId, assignmentId: winner.id, state: 'reserved',
				teamId: winner.teamId, projectId: winner.projectId, workDayId: winner.workdayId, reservedSeconds: winner.limits.maximumSeconds }]);
			expect(issuedPublic.reservations).toHaveLength(1); expect(issuedPublic.usage).toEqual([]); expect(issuedPublic.ledger).toEqual([]);
			expect((await new ProviderAssignmentRepository(peerAccounting).list('other-team', { workdayId: 'workday' })).items).toEqual([]);
			expect((await new ProviderAssignmentRepository(peerAccounting).list('team', { workdayId: 'other-workday' })).items).toEqual([]);
			// Both admissions observed absence, but the winner committed and was
			// leased/pinned before the losing SQL batch acquired the workday lock.
			const custody = { sourceWorkspace: { exactCommit: 'a'.repeat(40) }, retained: 'winner' };
			await proveNativeLeaseClaim(database, peerDatabase, accounting, peerAccounting, winner);
			await database.pool.query('UPDATE capacity_provider_assignments SET workspace_context_json=$1 WHERE id=$2', [JSON.stringify(custody), winner.id]);
			// An actual issued, leased attempt and its accounting records must remain
			// byte-identical when the owning team advances its default policy.
			const issuedState = async () => Object.fromEntries(await Promise.all([
				'capacity_workday_runs', 'execution_nodes', 'capacity_provider_assignments', 'capacity_reservations',
				'capacity_admission_counters', 'capacity_reservation_counter_claims', 'capacity_usage_actuals', 'capacity_ledger_entries',
			].map(async table => [table, (await peerDatabase.pool.query(`SELECT * FROM ${table} ORDER BY ${table === 'capacity_reservation_counter_claims' ? 'reservation_id,counter_id' : 'id'}`)).rows])));
			const beforePolicy = await issuedState(), leasedPublic = await publicInventory();
			const profiles = createWorkdayProfileService(accounting), principal = { id: 'owner', roles: ['admin'] };
			const frozenProfile = await profiles.profilesShow(principal, 'team', 'default');
			const policy = { ...frozenProfile.policy, planningPercent: 30, allocationWeight: 2 };
			expect(await profiles.profilesUpdate(principal, 'team', 'default', { policy }, String(frozenProfile.revision)))
				.toEqual({ ...frozenProfile, revision: frozenProfile.revision + 1, policy });
			const peerProfiles = createWorkdayProfileService(peerAccounting);
			expect(await peerProfiles.profilesShow(principal, 'team', 'default')).toEqual({ ...frozenProfile, revision: 2, policy });
			await expect(peerProfiles.profilesUpdate(principal, 'team', 'default', { policy: frozenProfile.policy }, '1'))
				.rejects.toMatchObject({ code: 'workday_profile_precondition_failed' });
			expect(await issuedState()).toEqual(beforePolicy); expect(await publicInventory()).toEqual(leasedPublic);
			expect(leasedPublic.assignments).toMatchObject([{ assignmentAttempt: { id: winner.id, leaseId: winner.leaseId }, leaseState: 'leased' }]);
			staleAdmissionRead = true;
			await run(winner);
			expect((await database.pool.query('SELECT workspace_context_json::jsonb AS context FROM capacity_provider_assignments WHERE id=$1', [winner.id])).rows[0].context)
				.toEqual(custody);
			await database.pool.query(`UPDATE capacity_provider_assignments SET status='pending',lease_state='unleased' WHERE id=$1`, [winner.id]);
			const admitted = await new ProviderAssignmentRepository(store as never).get('team', winner.id);
			if (!admitted?.assignmentAttempt) throw new Error('Complete admitted assignment authority is required for the settlement fixture.');
			expect(admitted.assignmentAttempt).toEqual({ ...winner, status: 'leased' });
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
			verifyNativeSettlementReadback(retained.ledger, published.ledger, retained.assignments);
			// Original independent SQL corruption; each owning rejection remains explicit.
			for (const field of ['requestedSeconds', 'reservedSeconds', 'allocatedSeconds', 'teamId', 'projectId', 'workDayId',
				'capacityProviderId', 'executionProviderId', 'reservationId', 'projectAgentClassId', 'mode', 'limits', 'explanation.teamId', 'explanation.assignmentId']) {
				const explanationField = field === 'allocatedSeconds' || field.startsWith('explanation.');
				const column = explanationField ? 'explanation_json' : 'capacity_envelope_json';
				const original = retained.assignments.find(value => value.id === winner.id)!, material = JSON.parse(String(original[column]));
				if (field === 'allocatedSeconds') material.metadata.allocation.allocatedSeconds++;
				else if (field.startsWith('explanation.')) material[field.slice('explanation.'.length)] = 'foreign';
				else if (field === 'requestedSeconds' || field === 'reservedSeconds') material[field]++; else material[field] = 'foreign';
				try {
					await peerDatabase.pool.query('UPDATE capacity_provider_assignments SET ' + column + '=$1 WHERE id=$2', [JSON.stringify(material), winner.id]);
					const failedNative = await state(peerDatabase), inspect = () => new ProviderAssignmentRepository(peerAccounting).list('team', { workdayId: 'workday', limit: 10 });
					if (field === 'mode') {
						let failedRead: unknown; try { await inspect(); } catch (failure) { failedRead = failure; }
						console.log(JSON.stringify({ nativeAllocationFailure: { field, original: original[column], observed: material, failedRead, controlledMetadata: true, managedProof: false } }));
						expect(failedRead).toMatchObject({ code: 'agent_capacity_envelope_mode_invalid', details: { assignmentId: winner.id, path: 'capacityEnvelope.mode' } });
					} else {
						const page = await inspect(), visible = page.items.find(value => value.id === winner.id)!, raw = failedNative.assignments.find(value => value.id === winner.id)!;
						const failedObservation = structuredClone({ raw, visible });
						console.log(JSON.stringify({ nativeAllocationFailure: { field, original: original[column], observed: material,
							publicEnvelope: visible.capacityEnvelope, publicExplanation: visible.explanation, executableSnapshot: visible.assignmentAttempt !== null, controlledMetadata: true, managedProof: false } }));
						if (visible.assignmentAttempt === null) {
							expect(visible.assignmentResult).toBeNull(); expect(column).toBe('capacity_envelope_json');
							expect(visible.explanation.snapshotValidation).toMatchObject({ valid: false, assignmentId: winner.id, path: 'capacityEnvelope.' + field });
						}
						expect(visible[explanationField ? 'explanation' : 'capacityEnvelope']).toEqual(material);
						expect(() => verifyNativeAssignmentReadback(raw, { ...visible }, { id: 'workday', teamId: 'team' }, failedNative.reservations, failedNative.assignments))
							.toThrow('ACCEPTANCE_NATIVE_ALLOCATION'); expect({ raw, visible }).toEqual(failedObservation);
					}
					expect(await state()).toEqual(failedNative);
				} finally { await peerDatabase.pool.query('UPDATE capacity_provider_assignments SET ' + column + '=$1 WHERE id=$2', [original[column], winner.id]); }
				expect(await state()).toEqual(retained); expect(await publicInventory()).toEqual(published);
			}
			// Corrupt only this disposable owning database through the independent connection.
			// The public serializer retains canonical metadata under the other valid phase;
			// strict acceptance must still deny the missing original terminal settlement.
			try {
				await peerDatabase.pool.query("UPDATE capacity_ledger_entries SET phase='reservation_released' WHERE id=$1", [retained.ledger[0]!.id]);
				const failedPublic = await publicInventory(), failedNative = await state(peerDatabase), originalFailure = structuredClone({ failedPublic, failedNative });
				expect(() => verifyNativeSettlementReadback(failedNative.ledger, failedPublic.ledger, failedNative.assignments))
					.toThrow('ACCEPTANCE_NATIVE_SETTLEMENT');
				expect({ failedPublic, failedNative }).toEqual(originalFailure); expect(await state()).toEqual(failedNative);
			} finally {
				await peerDatabase.pool.query("UPDATE capacity_ledger_entries SET phase='task_completed_actual_settlement' WHERE id=$1", [retained.ledger[0]!.id]);
			}
			expect(await state()).toEqual(retained); expect(await publicInventory()).toEqual(published);
			for (const replayed of await Promise.all([publicInventory(), publicInventory()]))
				verifyNativeSettlementReadback(retained.ledger, replayed.ledger, retained.assignments);

			expect(published.assignments.map(value => value.id)).toEqual(retained.assignments.map(value => value.id));
			expect(published.assignments.map(value => value.assignmentAttempt)).toEqual([admitted.assignmentAttempt]);
			expect(published.reservations.map(value => value.id)).toEqual(retained.reservations.map(value => value.id));
			expect(published.reservations[0]).toMatchObject({ assignmentId: winner.id, state: 'consumed', activeSeconds: 2, elapsedSeconds: 4,
				consumedProviderUnits: 0.25, consumedUsd: 0.001 });
			expect(published.usage.map(value => value.id)).toEqual(retained.usage.map(value => value.id));
			expect(published.usage[0]).toMatchObject({ assignmentId: winner.id, assignmentAttempt: winner.attempt, workDayId: winner.workdayId,
				accountingMode: 'aggregate', activeSeconds: 2, elapsedSeconds: 4, inputTokens: 7, outputTokens: 3, nativeUsage: settlement.usageActual.nativeUsage });
			expect(published.ledger.map(value => value.id)).toEqual(retained.ledger.map(value => value.id));
			const durableLedger = retained.ledger[0]!, metadata = JSON.parse(String(durableLedger.metadata_json));
			expect(settled[0]!.entry).toEqual(durableLedger);
			const { usageSettlement, ...publicMetadata } = metadata;
			expect(published.ledger).toEqual([{ id: durableLedger.id, settlementKey: settlement.settlementKey,
				membershipId: settlement.membershipId, capacityProviderId: winner.provider.providerId, reservationId: winner.reservationId,
				assignmentId: winner.id, mode: 'acting', teamId: winner.teamId, projectId: winner.projectId, workDayId: winner.workdayId,
				taskId: durableLedger.task_id, phase: 'task_completed_actual_settlement', activeSeconds: settlement.activeSeconds,
				elapsedSeconds: settlement.elapsedSeconds, providerUnits: settlement.providerUnits, usd: settlement.usd, source: settlement.source,
				metadata: publicMetadata, createdAt: durableLedger.created_at, usageSettlement }]);
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
			const directory = await mkdtemp(join(tmpdir(), 'api-native-model-inventory-'));
			try {
				const key = join(directory, 'diagnostics.key'); await writeFile(key, randomBytes(32).toString('base64url'), { mode: 0o600 });
				const envelopes = createDiagnosticEnvelopeService({ diagnosticsEncryptionKeyFile: key });
				const writer = new CapacityWorkdayEventRepository(accounting), reader = new CapacityWorkdayEventRepository(peerAccounting);
				const base = { projectId: 'project', workdayId: 'workday', assignmentId: winner.id, status: 'recorded' as const,
					title: null, message: 'Controlled original native event input; no model invocation claimed.', parameters: {}, refs: {}, createdAt: now };
				const start = await writer.create('team', 'workday', { ...base, id: 'controlled-model-start',
					eventType: 'provider.execution.started', context: { model: 'arbitrary-configured-model', isolation: 'microvm' }, metadata: {} });
				const payload = { providerEvents: [{ type: 'controlled-native-observation' }] };
				const protectedPayloadEnvelope = envelopes.encrypt(payload, { teamId: 'team', assignmentId: winner.id,
					resourceId: 'controlled-model-terminal', eventType: 'provider.execution.completed', sequence: 0 });
				const terminal = await writer.create('team', 'workday', { ...base, id: 'controlled-model-terminal',
					eventType: 'provider.execution.completed', context: {}, metadata: { protectedPayloadEnvelope } });
				expect(await reader.get('team', 'workday', start!.id)).toEqual(start);
				expect(await reader.get('team', 'workday', terminal!.id)).toEqual(terminal);
				const raw = (await peerDatabase.pool.query('SELECT * FROM capacity_workday_events WHERE assignment_id=$1 ORDER BY event_index', [winner.id])).rows;
				const owners = (await peerDatabase.pool.query('SELECT * FROM capacity_provider_assignments WHERE work_day_id=$1', ['workday'])).rows;
				const held = structuredClone({ raw, owners });
				expect([...verifyNativeModelExecutionInventory(owners, raw, { id: 'workday', teamId: 'team' })]).toEqual([winner.id]);
				expect(envelopes.decrypt(JSON.parse(String(raw[1]!.metadata_json)).protectedPayloadEnvelope)).toEqual(payload);
				for (const incomplete of [raw.slice(0, 1), raw.slice(1), [...raw, raw[0]!]])
					expect(() => verifyNativeModelExecutionInventory(owners, incomplete, { id: 'workday', teamId: 'team' })).toThrow();
				expect({ raw, owners }).toEqual(held); expect(await state()).toEqual(retained);
				expect((await peerDatabase.pool.query('SELECT * FROM capacity_workday_events WHERE assignment_id=$1 ORDER BY event_index', [winner.id])).rows).toEqual(raw);
			} finally { await rm(directory, { recursive: true, force: true }); }
		} finally {
			try { await Promise.all([database.close(), ...(peer ? [peer.close()] : [])]); }
			finally { try { await admin.query(`DROP DATABASE "${name}"`); } finally { await admin.end(); } }
		}
	}, 30_000);
});
