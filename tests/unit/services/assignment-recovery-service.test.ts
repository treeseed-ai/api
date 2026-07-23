import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { MarketPostgresDatabase } from '../../../src/api/market-postgres.ts';
import { MarketControlPlaneStore } from '../../../src/api/store.ts';
import { createCapacityControlPlane } from '../../../src/api/capacity/control-plane.ts';
import { recoverExpiredProviderAssignments } from '../../../src/api/capacity/services/assignment-recovery-service.ts';
import { reportCapacityUsage } from '../../../src/api/capacity/services/usage-report-service.ts';
import { settleCapacityReservationExactlyOnce } from '../../../src/api/capacity/services/settlement-service.ts';

const packageRoot = process.cwd();
const migrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market'))
	? resolve(packageRoot, '../sdk/drizzle/market')
	: resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');

function harness() {
	const memory = newDb();
	memory.public.registerFunction({ name: 'md5', args: [DataType.text], returns: DataType.text, implementation: (value: string) => `md5:${value}` });
	const pg = memory.adapters.createPg();
	const database = MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot });
	const host = new MarketControlPlaneStore({ repoRoot: packageRoot }, database);
	const store = createCapacityControlPlane(host);
	return { database, host, store };
}

async function seed(store: ReturnType<typeof harness>['store'], now: string) {
	await store.createTeam({ id: 'team-a', slug: 'team-a', name: 'team-a' });
	await store.run(`INSERT INTO capacity_providers (id, fingerprint, public_jwk_json, display_name, identity_version, status, metadata_json, created_at, updated_at) VALUES ('provider-a', 'sha256:provider-a', '{}', 'Provider A', 1, 'active', '{}', ?, ?)`, [now, now]);
	await store.run(`INSERT INTO capacity_provider_team_memberships (id, team_id, capacity_provider_id, status, approved_at, approved_by_id, metadata_json, created_at, updated_at) VALUES ('membership-a', 'team-a', 'provider-a', 'approved', ?, 'owner-a', '{}', ?, ?)`, [now, now, now]);
	await store.run(`INSERT INTO capacity_execution_providers (id, capacity_provider_id, display_name, adapter, status, capabilities_json, native_unit, quota_visibility, max_concurrent_runners, native_limits_json, metadata_json, created_at, updated_at) VALUES ('codex', 'provider-a', 'Codex', 'codex', 'active', '[]', 'credit', 'exact', 4, '[]', '{}', ?, ?)`, [now, now]);
	await store.run(`INSERT INTO projects (id, team_id, slug, name, metadata_json, created_at, updated_at) VALUES ('project-a', 'team-a', 'project-a', 'Project A', '{}', ?, ?)`, [now, now]);
	await store.run(`INSERT INTO project_agent_classes (id, team_id, project_id, slug, name, status, allowed_modes_json, required_capabilities_json, kernel_profile_json, kernel_policy_json, handler_refs_json, output_contracts_json, metadata_json, created_at, updated_at) VALUES ('class-a', 'team-a', 'project-a', 'engineer', 'Engineer', 'active', '["planning"]', '[]', '{}', '{}', '{}', '{}', '{}', ?, ?)`, [now, now]);
	await store.run(`INSERT INTO capacity_allocation_sets (id, team_id, version, status, effective_from, reserve_policy_json, slices_json, borrowing_rules_json, metadata_json, created_at, updated_at) VALUES ('allocation-a', 'team-a', 1, 'active', ?, '{"percent":0,"overflow":"deny"}', '[]', '[]', '{}', ?, ?)`, [now, now, now]);
	await store.run(`INSERT INTO capacity_grants (id, membership_id, capacity_provider_id, team_id, project_id, environment, status, execution_provider_ids_json, lane_ids_json, capabilities_json, allowed_modes_json, daily_credit_limit, monthly_credit_limit, max_concurrent_assignments, unmetered, metadata_json, created_at, updated_at) VALUES ('grant-a', 'membership-a', 'provider-a', 'team-a', 'project-a', 'local', 'active', '["codex"]', '[]', '[]', '["planning"]', 100, 100, 4, 0, '{}', ?, ?)`, [now, now]);
	await store.run(`INSERT INTO workday_capacity_envelopes (id, team_id, project_id, allocation_set_id, status, started_at, envelope_json, metadata_json, created_at, updated_at) VALUES ('workday-a', 'team-a', 'project-a', 'allocation-a', 'active', ?, '{"totalCredits":100}', '{}', ?, ?)`, [now, now, now]);
}

async function expiredAssignment(store: ReturnType<typeof harness>['store'], id: string, now: string, input: { attemptCount?: number; maxAttempts?: number } = {}) {
	const reservationId = `reservation-${id}`;
	await store.run(`INSERT INTO capacity_reservations (id, idempotency_key, admission_token, membership_id, grant_id, capacity_provider_id, execution_provider_id, allocation_set_id, allocation_version, allocation_slice_ids_json, policy_snapshot_json, project_agent_class_id, assignment_id, mode, team_id, project_id, work_day_id, state, reserved_credits, consumed_credits, metadata_json, created_at, updated_at) VALUES (?, ?, ?, 'membership-a', 'grant-a', 'provider-a', 'codex', 'allocation-a', 1, '[]', '{}', 'class-a', ?, 'planning', 'team-a', 'project-a', 'workday-a', 'reserved', 2, 0, '{}', ?, ?)`, [reservationId, `admit-${id}`, `token-${id}`, id, now, now]);
	await store.run(`INSERT INTO capacity_provider_assignments (id, membership_id, team_id, project_id, capacity_provider_id, execution_provider_id, allocation_set_id, project_agent_class_id, reservation_id, work_day_id, mode, status, lease_state, lease_token, lease_expires_at, state_version, attempt_count, capacity_envelope_json, decision_input_json, metadata_json, created_at, updated_at) VALUES (?, 'membership-a', 'team-a', 'project-a', 'provider-a', 'codex', 'allocation-a', 'class-a', ?, 'workday-a', 'planning', 'leased', 'leased', ?, '2026-07-18T11:59:00.000Z', 1, ?, '{"teamId":"team-a","projectId":"project-a","mode":"planning"}', '{"teamId":"team-a","projectId":"project-a","projectAgentClassId":"class-a","mode":"planning","input":{}}', ?, ?, ?)`, [id, reservationId, `lease-${id}`, input.attemptCount ?? 0, JSON.stringify({ retryPolicy: { maxAttempts: input.maxAttempts ?? 3 } }), now, now]);
	return reservationId;
}

describe('expired assignment recovery', () => {
	it('converges a provider failure interrupted after settlement but before lifecycle transition', async () => {
		const { database, host, store } = harness();
		try {
			await store.ensureInitialized();
			const now = '2026-07-18T12:00:00.000Z';
			await seed(store, now);
			await expiredAssignment(store, 'interrupted-provider-failure', now);
			await store.run(`UPDATE capacity_provider_assignments SET lease_expires_at = '2099-01-01T00:00:00.000Z' WHERE id = 'interrupted-provider-failure'`);
			let batchCalls = 0;
			const interruptedHost = new Proxy(host, {
				get(target, property) {
					if (property === 'batch') return async (operations: Parameters<typeof target.batch>[0]) => {
						batchCalls += 1;
						if (batchCalls === 2) throw new Error('injected lifecycle transition interruption');
						return target.batch(operations);
					};
					const value = Reflect.get(target, property, target);
					return typeof value === 'function' ? value.bind(target) : value;
				},
			});
			const interrupted = createCapacityControlPlane(interruptedHost);
			await expect(interrupted.failProviderAssignment(
				{ teamId: 'team-a', membershipId: 'membership-a', capacityProviderId: 'provider-a' },
				'interrupted-provider-failure',
				{ leaseToken: 'lease-interrupted-provider-failure', actualCredits: 1, code: 'execution_failed', retryable: false },
			)).rejects.toThrow('injected lifecycle transition interruption');
			expect(await store.first(`SELECT status FROM capacity_provider_assignments WHERE id = 'interrupted-provider-failure'`)).toEqual({ status: 'leased' });
			expect(await store.first(`SELECT state, consumed_credits FROM capacity_reservations WHERE id = 'reservation-interrupted-provider-failure'`)).toEqual({ state: 'consumed', consumed_credits: 1 });
			await store.run(`UPDATE capacity_provider_assignments SET lease_expires_at = '2026-07-18T11:59:00.000Z' WHERE id = 'interrupted-provider-failure'`);
			await expect(recoverExpiredProviderAssignments(store, { teamId: 'team-a', providerId: 'provider-a', now })).resolves.toMatchObject({ recovered: 1, terminalFailures: 1 });
			expect(await store.first(`SELECT status, lifecycle_code FROM capacity_provider_assignments WHERE id = 'interrupted-provider-failure'`)).toEqual({ status: 'failed', lifecycle_code: 'provider_failure_settlement_recovered' });
		} finally { await database.close(); }
	});

	it('classifies safe retry, exhausted retry, recovered completion, and operator action exactly once', async () => {
		const { database, store } = harness();
		try {
			await store.ensureInitialized();
			const now = '2026-07-18T12:00:00.000Z';
			await seed(store, now);
			await expiredAssignment(store, 'safe', now);
			await expiredAssignment(store, 'terminal', now, { maxAttempts: 1 });
			const operatorReservation = await expiredAssignment(store, 'operator', now);
			const completedReservation = await expiredAssignment(store, 'completed', now);
			const intermediateReservation = await expiredAssignment(store, 'intermediate', now);
			const providerFailureReservation = await expiredAssignment(store, 'provider-failure', now);
			await reportCapacityUsage(store, { teamId: 'team-a', membershipId: 'membership-a', reservationId: operatorReservation, assignmentId: 'operator', idempotencyKey: 'operator-usage', usageDimension: 'tool-events', accountingMode: 'informational', actualCredits: 0, source: 'test' });
			await store.createAgentModeRun({ id: 'operator-run', teamId: 'team-a', providerAssignmentId: 'operator', status: 'running' });
			await settleCapacityReservationExactlyOnce(store, { settlementKey: 'completed-settlement', teamId: 'team-a', membershipId: 'membership-a', reservationId: completedReservation, assignmentId: 'completed', actualCredits: 1, source: 'provider_usage_report' });
			await store.createAgentModeRun({ id: 'completed-run', teamId: 'team-a', providerAssignmentId: 'completed', status: 'succeeded' });
			await settleCapacityReservationExactlyOnce(store, { settlementKey: 'intermediate-settlement', teamId: 'team-a', membershipId: 'membership-a', reservationId: intermediateReservation, assignmentId: 'intermediate', actualCredits: 0, source: 'expired_lease_recovery' });
			await settleCapacityReservationExactlyOnce(store, { settlementKey: 'provider-failure-settlement', teamId: 'team-a', membershipId: 'membership-a', reservationId: providerFailureReservation, assignmentId: 'provider-failure', actualCredits: 1, source: 'provider_assignment_fail' });

			const first = await recoverExpiredProviderAssignments(store, { teamId: 'team-a', providerId: 'provider-a', now });
			expect(first).toMatchObject({ scanned: 6, recovered: 6, safeRetries: 1, terminalFailures: 3, completed: 1, operatorActions: 1 });
			expect(await store.first(`SELECT status, lease_state, attempt_count, lifecycle_code FROM capacity_provider_assignments WHERE id = 'safe'`)).toEqual({ status: 'returned', lease_state: 'released', attempt_count: 1, lifecycle_code: 'expired_lease_safe_retry' });
			expect(await store.first(`SELECT status, lease_state, lifecycle_code FROM capacity_provider_assignments WHERE id = 'terminal'`)).toEqual({ status: 'failed', lease_state: 'released', lifecycle_code: 'expired_lease_retry_exhausted' });
			expect(await store.first(`SELECT status, lease_state, lifecycle_code FROM capacity_provider_assignments WHERE id = 'completed'`)).toEqual({ status: 'completed', lease_state: 'released', lifecycle_code: 'expired_lease_completion_recovered' });
			expect(await store.first(`SELECT status, lease_state, lifecycle_code FROM capacity_provider_assignments WHERE id = 'intermediate'`)).toEqual({ status: 'failed', lease_state: 'released', lifecycle_code: 'expired_lease_terminal_settlement_recovered' });
			expect(await store.first(`SELECT status, lease_state, lifecycle_code FROM capacity_provider_assignments WHERE id = 'provider-failure'`)).toEqual({ status: 'failed', lease_state: 'released', lifecycle_code: 'provider_failure_settlement_recovered' });
			expect(await store.first(`SELECT status, lease_state, lifecycle_code FROM capacity_provider_assignments WHERE id = 'operator'`)).toEqual({ status: 'expired', lease_state: 'expired', lifecycle_code: 'expired_lease_side_effect_evidence_present' });
			expect(await store.first(`SELECT status, fallback_reason FROM agent_mode_runs WHERE id = 'operator-run'`)).toEqual({ status: 'failed', fallback_reason: 'expired_lease_side_effect_evidence_present' });
			expect(await store.first(`SELECT state, consumed_credits FROM capacity_reservations WHERE id = 'reservation-terminal'`)).toEqual({ state: 'consumed', consumed_credits: 0 });
			expect(await store.first(`SELECT COUNT(*) AS total FROM capacity_audit_events WHERE action LIKE 'capacity-assignment.recovery.%'`)).toEqual({ total: 6 });
			expect(await recoverExpiredProviderAssignments(store, { teamId: 'team-a', providerId: 'provider-a', now })).toMatchObject({ scanned: 0, recovered: 0 });
		} finally { await database.close(); }
	});
});
