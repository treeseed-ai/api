import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DataType, newDb } from 'pg-mem';
import { MarketControlPlaneStore } from '../../src/api/store.js';
import { createCapacityControlPlane } from '../../src/api/capacity/control-plane.ts';
import { MarketPostgresDatabase } from '../../src/api/market-postgres.js';
import { CapacityGrantService } from '../../src/api/capacity/services/grant-service.ts';
import { aggregateNativeReservationDebits } from '../../src/api/capacity/services/native-reservation-aggregation-service.ts';
import { decodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const marketMigrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market'))
	? resolve(packageRoot, '../sdk/drizzle/market')
	: resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');

function createStore() {
	const memory = newDb();
	memory.public.registerFunction({
		name: 'md5',
		args: [DataType.text],
		returns: DataType.text,
		implementation: (value: string) => `md5:${value}`,
	});
	const pg = memory.adapters.createPg();
	const db = MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot: marketMigrationRoot });
	const store = createCapacityControlPlane(new MarketControlPlaneStore({
		repoRoot: packageRoot,
		authSecret: 'test-auth-secret',
		assertionSecret: 'test-assertion-secret',
		serviceId: 'web',
		serviceSecret: 'test-service-secret',
	}, db));
	return { db, store };
}

describe('workday runs', () => {
	it('enforces clean workday and capacity-plan governance constraints', async () => {
		const { db, store } = createStore();
		try {
			await store.ensureInitialized();
			const now = new Date().toISOString();
			await store.run(`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, ['team-constraints', 'team-constraints', 'Constraint Team', now, now]);
			await store.run(`INSERT INTO projects (id, team_id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, ['project-constraints', 'team-constraints', 'constraints', 'Constraint Project', now, now]);
			await expect(store.run(
				`INSERT INTO workday_capacity_envelopes (id, team_id, project_id, status, created_at, updated_at) VALUES ('workday-invalid-status', 'team-constraints', 'project-constraints', 'running', ?, ?)`,
				[now, now],
			)).rejects.toThrow(/check constraint/iu);
			await expect(store.run(
				`INSERT INTO workday_capacity_envelopes (id, team_id, project_id, status, created_at, updated_at) VALUES ('workday-invalid-project', 'team-constraints', 'missing-project', 'draft', ?, ?)`,
				[now, now],
			)).rejects.toThrow(/foreign key/iu);
			await expect(store.run(
				`INSERT INTO agent_capacity_plans (id, team_id, project_id, decision_id, status, scope_hash, expected_credits, high_credits, created_at, updated_at) VALUES ('plan-invalid-credits', 'team-constraints', 'project-constraints', 'decision-a', 'draft', 'scope-a', 5, 4, ?, ?)`,
				[now, now],
			)).rejects.toThrow(/check constraint/iu);
			await expect(store.run(
				`INSERT INTO agent_capacity_plans (id, team_id, project_id, decision_id, status, scope_hash, created_at, updated_at) VALUES ('plan-invalid-status', 'team-constraints', 'project-constraints', 'decision-a', 'approved', 'scope-a', ?, ?)`,
				[now, now],
			)).rejects.toThrow(/check constraint/iu);
		} finally {
			db.close();
		}
	});

	it('keeps lifecycle explanations on the canonical assignment row', async () => {
		const { db, store } = createStore();
		try {
			await store.ensureInitialized();
			const now = new Date().toISOString();
			await store.run(`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, ['team-explanation', 'team-explanation', 'Explanation Team', now, now]);
			await store.run(`INSERT INTO projects (id, team_id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, ['project-explanation', 'team-explanation', 'project-explanation', 'Explanation Project', now, now]);
			await store.run(`INSERT INTO capacity_providers (id, fingerprint, public_jwk_json, display_name, identity_version, status, metadata_json, created_at, updated_at) VALUES (?, ?, '{}', ?, 1, 'active', '{}', ?, ?)`, ['provider-explanation', 'sha256:provider-explanation', 'Explanation Provider', now, now]);
			await store.run(`INSERT INTO capacity_provider_team_memberships (id, team_id, capacity_provider_id, status, approved_at, approved_by_id, metadata_json, created_at, updated_at) VALUES (?, ?, ?, 'approved', ?, ?, '{}', ?, ?)`, ['membership-explanation', 'team-explanation', 'provider-explanation', now, 'owner', now, now]);
			await store.run(`INSERT INTO project_agent_classes (id, team_id, project_id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ['class-explanation', 'team-explanation', 'project-explanation', 'researcher', 'Researcher', now, now]);
			await store.run(`INSERT INTO capacity_allocation_sets (id, team_id, version, status, effective_from, reserve_policy_json, slices_json, borrowing_rules_json, metadata_json, created_at, updated_at) VALUES ('allocation-test', 'team-explanation', 1, 'active', ?, '{}', '[]', '[]', '{}', ?, ?)`, [now, now, now]);
			await store.run(`INSERT INTO capacity_grants (id, membership_id, capacity_provider_id, team_id, project_id, environment, status, capabilities_json, allowed_modes_json, daily_credit_limit, metadata_json, created_at, updated_at) VALUES ('grant-test', 'membership-explanation', 'provider-explanation', 'team-explanation', 'project-explanation', 'local', 'active', '[]', '["planning"]', 10, '{}', ?, ?)`, [now, now]);
			const assignmentEnvelope = JSON.stringify({ teamId: 'team-explanation', projectId: 'project-explanation', mode: 'planning' });
			const decisionInput = JSON.stringify({ teamId: 'team-explanation', projectId: 'project-explanation', projectAgentClassId: 'class-explanation', mode: 'planning', input: {} });
			await store.run(`INSERT INTO capacity_provider_assignments (id, membership_id, team_id, project_id, capacity_provider_id, project_agent_class_id, mode, capacity_envelope_json, decision_input_json, explanation_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'planning', ?, ?, ?, ?, ?)`, [
				'assignment-explanation', 'membership-explanation', 'team-explanation', 'project-explanation', 'provider-explanation', 'class-explanation',
				assignmentEnvelope, decisionInput, JSON.stringify({ source: 'admission', eligible: true, reasons: ['policy allowed'], gates: { grantId: 'grant-a' } }), now, now,
			]);
			await store.run(`INSERT INTO capacity_provider_assignments (id, membership_id, team_id, project_id, capacity_provider_id, project_agent_class_id, mode, capacity_envelope_json, decision_input_json, explanation_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'planning', ?, ?, '{}', ?, ?)`, [
				'assignment-other', 'membership-explanation', 'team-explanation', 'project-explanation', 'provider-explanation', 'class-explanation', assignmentEnvelope, decisionInput, now, now,
			]);
			const updated = await store.recordProviderAssignmentExplanation('team-explanation', 'assignment-explanation', {
				source: 'lease_next_assignment', eligible: false, reasons: ['lease_still_active'], gates: { runnerId: 'runner-a' },
			});
			expect(updated).toMatchObject({ assignmentId: 'assignment-explanation', source: 'lease_next_assignment', eligible: false, reasons: ['lease_still_active'] });
			expect(await store.getProviderAssignment('team-explanation', 'assignment-explanation')).toMatchObject({
				explanation: { source: 'lease_next_assignment', metadata: { history: [expect.objectContaining({ source: 'admission' })] } },
			});
			const firstPage = await store.listProviderAssignmentsPage('team-explanation', { limit: 1 });
			expect(firstPage).toMatchObject({
				items: [{ id: 'assignment-other' }],
				page: { limit: 1, hasMore: true, nextCursor: expect.any(String) },
			});
			const secondPage = await store.listProviderAssignmentsPage('team-explanation', {
				limit: 1,
				cursor: decodeCapacityPageCursor(firstPage.page.nextCursor),
			});
			expect(secondPage).toMatchObject({
				items: [{ id: 'assignment-explanation' }],
				page: { limit: 1, hasMore: false, nextCursor: null },
			});
			await expect(store.listProviderAssignmentsPage('team-explanation', {
				assignmentId: 'assignment-explanation',
				limit: 50,
			})).resolves.toMatchObject({
				items: [{ id: 'assignment-explanation' }],
			});
			const duplicateTable = await store.first(`SELECT table_name FROM information_schema.tables WHERE table_name = 'provider_assignment_explanations'`);
			expect(duplicateTable).toBeNull();
			await expect(store.recordAgentFallbackOutput({
				id: 'fallback-explanation',
				projectId: 'project-explanation',
				assignmentId: 'assignment-explanation',
				mode: 'planning',
				code: 'planning_input_unavailable',
				status: 'emitted',
				output: { title: 'Bounded fallback' },
				provenance: { handlerId: 'research' },
				quota: { emitted: 1, limit: 1 },
			})).resolves.toMatchObject({
				id: 'fallback-explanation',
				teamId: 'team-explanation',
				projectId: 'project-explanation',
				assignmentId: 'assignment-explanation',
				status: 'emitted',
			});
			await expect(store.listAgentFallbackOutputsPage('project-explanation', { limit: 1 })).resolves.toMatchObject({
				items: [{ id: 'fallback-explanation', output: { title: 'Bounded fallback' } }],
				page: { limit: 1, hasMore: false, nextCursor: null },
			});

			await store.run(
				`UPDATE capacity_provider_assignments
				 SET status = 'completed', synthesized_from = 'workday_demand', metadata_json = '{"workdayRunId":"run-terminalization"}'
				 WHERE id = 'assignment-explanation'`,
			);
			await store.run(
				`INSERT INTO capacity_reservations (
					id, idempotency_key, admission_token, membership_id, grant_id, capacity_provider_id,
					allocation_set_id, allocation_version, project_agent_class_id, assignment_id, mode,
					team_id, project_id, state, reserved_credits, created_at, updated_at
				) VALUES ('reservation-other', 'terminal-other', 'token-other', 'membership-explanation', 'grant-test',
					'provider-explanation', 'allocation-test', 1, 'class-explanation', 'assignment-other', 'planning',
					'team-explanation', 'project-explanation', 'reserved', 1, ?, ?)`,
				[now, now],
			);
			await store.run(
				`UPDATE capacity_provider_assignments
				 SET status = 'pending', reservation_id = 'reservation-other', synthesized_from = 'workday_demand', metadata_json = '{"workdayRunId":"run-terminalization"}'
				 WHERE id = 'assignment-other'`,
			);
			await store.createAgentModeRun({
				id: 'mode-completed-assignment',
				teamId: 'team-explanation',
				providerAssignmentId: 'assignment-explanation',
				status: 'running',
				startedAt: now,
			});
			await store.createAgentModeRun({
				id: 'mode-unfinished-assignment',
				teamId: 'team-explanation',
				providerAssignmentId: 'assignment-other',
				status: 'running',
				startedAt: now,
			});
			await store.run(`INSERT INTO capacity_workday_runs (id, team_id, status, scenario_id, environment, created_at, updated_at) VALUES ('run-terminalization', 'team-explanation', 'failed', 'recovery-test', 'local', ?, ?)`, [now, now]);
			await store.createWorkdayCapacityEnvelope({ id: 'workday-terminalization', workdayRunId: 'run-terminalization', projectId: 'project-explanation', status: 'active', availableCredits: 1 });
			await store.run(`INSERT INTO capacity_workday_demands (id, team_id, project_id, workday_run_id, workday_id, source_type, source_id, mode, project_agent_class_id, agent_id, handler_id, activity_type, status, priority, requested_credits, idempotency_key, assignment_id, payload_json, metadata_json, available_at, admitted_at, completed_at, created_at, updated_at) VALUES
				('demand-completed', 'team-explanation', 'project-explanation', 'run-terminalization', 'workday-terminalization', 'idle-intent', 'completed', 'planning', 'class-explanation', 'researcher', 'writer', 'planning', 'completed', 1, 1, 'demand-completed', 'assignment-explanation', '{}', '{}', ?, ?, ?, ?, ?),
				('demand-unfinished', 'team-explanation', 'project-explanation', 'run-terminalization', 'workday-terminalization', 'idle-intent', 'unfinished', 'planning', 'class-explanation', 'researcher', 'writer', 'planning', 'admitted', 1, 1, 'demand-unfinished', 'assignment-other', '{}', '{}', ?, ?, NULL, ?, ?)`, [now, now, now, now, now, now, now, now, now]);
			expect(await store.maintainCapacityWorkdayRuns('team-explanation', now)).toEqual({ expired: 0, recoveredTerminalRuns: 1 });
			expect(await store.getAgentModeRun('team-explanation', 'mode-completed-assignment')).toMatchObject({
				status: 'running',
				fallbackReason: null,
			});
			expect(await store.getAgentModeRun('team-explanation', 'mode-unfinished-assignment')).toMatchObject({
				status: 'failed',
				fallbackReason: 'Recovered unfinished assignment state from terminal workday run-terminalization.',
			});
			expect(await store.getWorkdayCapacityEnvelope('workday-terminalization')).toMatchObject({ status: 'failed' });
			expect(await store.maintainCapacityWorkdayRuns('team-explanation', now)).toEqual({ expired: 0, recoveredTerminalRuns: 0 });
		} finally {
			db.close();
		}
	});

	it('terminalizes workday assignments in bounded batches', async () => {
		const { db, store } = createStore();
		try {
			await store.ensureInitialized();
			const now = new Date().toISOString();
			await store.run(`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, ['team-batched-terminal', 'team-batched-terminal', 'Batched Terminal Team', now, now]);
			await store.run(`INSERT INTO projects (id, team_id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, ['project-batched-terminal', 'team-batched-terminal', 'batched-terminal', 'Batched Terminal Project', now, now]);
			await store.run(`INSERT INTO capacity_providers (id, fingerprint, public_jwk_json, display_name, identity_version, status, metadata_json, created_at, updated_at) VALUES (?, ?, '{}', ?, 1, 'active', '{}', ?, ?)`, ['provider-batched-terminal', 'sha256:provider-batched-terminal', 'Batched Terminal Provider', now, now]);
			await store.run(`INSERT INTO capacity_provider_team_memberships (id, team_id, capacity_provider_id, status, approved_at, approved_by_id, metadata_json, created_at, updated_at) VALUES (?, ?, ?, 'approved', ?, ?, '{}', ?, ?)`, ['membership-batched-terminal', 'team-batched-terminal', 'provider-batched-terminal', now, 'owner', now, now]);
			await store.run(`INSERT INTO project_agent_classes (id, team_id, project_id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ['class-batched-terminal', 'team-batched-terminal', 'project-batched-terminal', 'researcher', 'Researcher', now, now]);
			await store.run(`INSERT INTO capacity_allocation_sets (id, team_id, version, status, effective_from, reserve_policy_json, slices_json, borrowing_rules_json, metadata_json, created_at, updated_at) VALUES ('allocation-test', 'team-batched-terminal', 1, 'active', ?, '{}', '[]', '[]', '{}', ?, ?)`, [now, now, now]);
			await store.run(`INSERT INTO capacity_grants (id, membership_id, capacity_provider_id, team_id, project_id, environment, status, capabilities_json, allowed_modes_json, daily_credit_limit, metadata_json, created_at, updated_at) VALUES ('grant-test', 'membership-batched-terminal', 'provider-batched-terminal', 'team-batched-terminal', 'project-batched-terminal', 'local', 'active', '[]', '["planning"]', 500, '{}', ?, ?)`, [now, now]);
			await store.run(`INSERT INTO capacity_workday_runs (id, team_id, capacity_provider_id, scenario_id, status, environment, parameters_json, created_at, updated_at) VALUES ('run-batched-terminal', 'team-batched-terminal', 'provider-batched-terminal', 'batch terminalization', 'failed', 'local', '{}', ?, ?)`, [now, now]);
			await store.createWorkdayCapacityEnvelope({
				id: 'workday-batched-summary',
				workdayRunId: 'run-batched-terminal',
				projectId: 'project-batched-terminal',
				status: 'active',
				availableCredits: 500,
			});
			const assignmentCount = 201;
			const reservationValues = [];
			const reservationRows = Array.from({ length: assignmentCount }, (_, index) => {
				const suffix = String(index).padStart(3, '0');
				reservationValues.push(
					`reservation-batched-${suffix}`,
					`terminal-batched-${suffix}`,
					`token-batched-${suffix}`,
					`assignment-batched-${suffix}`,
					now,
					now,
				);
				return `(?, ?, ?, 'membership-batched-terminal', 'grant-test', 'provider-batched-terminal',
					'allocation-test', 1, 'class-batched-terminal', ?, 'planning', 'team-batched-terminal',
					'project-batched-terminal', 'workday-batched-summary', 'reserved', 1, ?, ?)`;
			});
			await store.run(
				`INSERT INTO capacity_reservations (
					id, idempotency_key, admission_token, membership_id, grant_id, capacity_provider_id,
					allocation_set_id, allocation_version, project_agent_class_id, assignment_id, mode,
					team_id, project_id, work_day_id, state, reserved_credits, created_at, updated_at
				) VALUES ${reservationRows.join(', ')}`,
				reservationValues,
			);
			const assignmentValues = [];
			const assignmentRows = Array.from({ length: assignmentCount }, (_, index) => {
				const suffix = String(index).padStart(3, '0');
				assignmentValues.push(
					`assignment-batched-${suffix}`,
					'membership-batched-terminal',
					'team-batched-terminal',
					'project-batched-terminal',
					'provider-batched-terminal',
					'class-batched-terminal',
					`reservation-batched-${suffix}`,
					'workday-batched-summary',
					now,
					now,
				);
				return `(?, ?, ?, ?, ?, ?, ?, 'planning', ?, 'pending', 'workday_demand',
					'{"teamId":"team-batched-terminal","projectId":"project-batched-terminal","mode":"planning"}',
					'{"teamId":"team-batched-terminal","projectId":"project-batched-terminal","projectAgentClassId":"class-batched-terminal","mode":"planning","input":{}}',
					'{"workdayRunId":"run-batched-terminal"}', ?, ?)`;
			});
			await store.run(
				`INSERT INTO capacity_provider_assignments (
					id, membership_id, team_id, project_id, capacity_provider_id, project_agent_class_id,
					reservation_id, mode, work_day_id, status, synthesized_from, capacity_envelope_json,
					decision_input_json, metadata_json, created_at, updated_at
				) VALUES ${assignmentRows.join(', ')}`,
				assignmentValues,
			);
			const demandValues = [];
			const demandRows = Array.from({ length: assignmentCount }, (_, index) => {
				const suffix = String(index).padStart(3, '0');
				demandValues.push(`demand-batched-${suffix}`, `source-${suffix}`, `demand-key-${suffix}`, `assignment-batched-${suffix}`, now, now, now, now);
				return `(?, 'team-batched-terminal', 'project-batched-terminal', 'run-batched-terminal', 'workday-batched-summary',
				 'idle-intent', ?, 'planning', 'class-batched-terminal', 'researcher', 'writer', 'planning', 'admitted', 1, 1, ?, ?, '{}', '{}', ?, ?, ?, ?)`;
			});
			await store.run(`INSERT INTO capacity_workday_demands (id, team_id, project_id, workday_run_id, workday_id, source_type, source_id, mode, project_agent_class_id, agent_id, handler_id, activity_type, status, priority, requested_credits, idempotency_key, assignment_id, payload_json, metadata_json, available_at, admitted_at, created_at, updated_at) VALUES ${demandRows.join(', ')}`, demandValues);

			const terminalization = await store.terminalizeCapacityWorkdayAssignments(
				'team-batched-terminal',
				'run-batched-terminal',
				{ now },
			);
			expect(terminalization).toMatchObject({
				assignmentCount,
				completedAssignments: 0,
				failedAssignments: assignmentCount,
				unfinishedAssignmentCount: 0,
				settlementErrorCount: 0,
				settlementErrorsTruncated: false,
			});
			expect(terminalization.settlementErrors).toEqual([]);
			expect(Number((await store.first(
				`SELECT COUNT(*) AS count FROM capacity_provider_assignments WHERE team_id = ? AND status = 'failed'`,
				['team-batched-terminal'],
			))?.count ?? 0)).toBe(assignmentCount);
			expect(Number((await store.first(
				`SELECT COUNT(*) AS count FROM capacity_reservations WHERE team_id = ? AND state = 'consumed'`,
				['team-batched-terminal'],
			))?.count ?? 0)).toBe(assignmentCount);
			const modeRunValues = [];
			const modeRunRows = Array.from({ length: assignmentCount }, (_, index) => {
				modeRunValues.push(
					`mode-batched-${String(index).padStart(3, '0')}`,
					'team-batched-terminal',
					'project-batched-terminal',
					`assignment-batched-${String(index).padStart(3, '0')}`,
					'provider-batched-terminal',
					'class-batched-terminal',
					now,
					now,
				);
				return `(?, ?, ?, ?, ?, ?, 'planning', 'succeeded',
					'{"teamId":"team-batched-terminal","projectId":"project-batched-terminal","mode":"planning"}', ?, ?)`;
			});
			await store.run(
				`INSERT INTO agent_mode_runs (
					id, team_id, project_id, provider_assignment_id, capacity_provider_id,
					project_agent_class_id, mode, status, capacity_envelope_json, created_at, updated_at
				) VALUES ${modeRunRows.join(', ')}`,
				modeRunValues,
			);
			const fallbackValues = [];
			const fallbackRows = Array.from({ length: 51 }, (_, index) => {
				fallbackValues.push(
					`fallback-batched-${String(index).padStart(3, '0')}`,
					'team-batched-terminal',
					'project-batched-terminal',
					`assignment-batched-${String(index).padStart(3, '0')}`,
					now,
				);
				return `(?, ?, ?, ?, 'planning', 'planning_input_unavailable', 'emitted', '{}', '{}', '{}', '{}', ?)`;
			});
			await store.run(
				`INSERT INTO agent_fallback_outputs (
					id, team_id, project_id, assignment_id, mode, code, status,
					output_json, provenance_json, quota_json, metadata_json, created_at
				) VALUES ${fallbackRows.join(', ')}`,
				fallbackValues,
			);
			const diagnostics = await store.getProjectCapacityRuntimeDiagnostics('project-batched-terminal', 'team-batched-terminal');
			expect(diagnostics).toMatchObject({
				windows: {
					assignments: { limit: 50, total: assignmentCount, hasMore: true, nextCursor: expect.any(String) },
					modeRuns: { limit: 50, total: assignmentCount, hasMore: true, nextCursor: expect.any(String) },
					fallbackOutputs: { limit: 50, total: 51, hasMore: true, nextCursor: expect.any(String) },
				},
			});
			expect(diagnostics.assignments).toHaveLength(50);
			expect(diagnostics.modeRuns).toHaveLength(50);
			expect(diagnostics.fallbackOutputs).toHaveLength(50);
			const summary = await store.getWorkdayCapacitySummary('workday-batched-summary');
			expect(summary).toMatchObject({
				payload: {
					totals: {
						assignments: { total: assignmentCount, failed: assignmentCount },
						modeRuns: { total: assignmentCount, succeeded: assignmentCount },
					},
					evidence: {
						assignments: { total: assignmentCount, page: { limit: 50, hasMore: true, nextCursor: expect.any(String) } },
						modeRuns: { total: assignmentCount, page: { limit: 50, hasMore: true, nextCursor: expect.any(String) } },
					},
				},
			});
			expect(summary.payload.evidence.assignments.items).toHaveLength(50);
			const nextSummary = await store.getWorkdayCapacitySummary('workday-batched-summary', {
				evidence: 'assignments',
				limit: 50,
				cursor: decodeCapacityPageCursor(summary.payload.evidence.assignments.page.nextCursor),
			});
			expect(nextSummary.payload.evidence.assignments.items).toHaveLength(50);
			expect(nextSummary.payload.evidence.assignments.items[0]?.id).not.toBe(summary.payload.evidence.assignments.items[0]?.id);
		} finally {
			db.close();
		}
	});

	it('schedules only from existing governance and preserves grants and allocations', async () => {
		const { db, store } = createStore();
		try {
			await store.ensureInitialized();
			const now = new Date().toISOString();
			const effectiveFrom = new Date(Date.now() - 60_000).toISOString();
			await store.run(`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, ['team-governed', 'team-governed', 'Governed Team', now, now]);
			await store.run(`INSERT INTO projects (id, team_id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, ['project-agent', 'team-governed', 'agent', 'Agent', now, now]);
			await store.run(`INSERT INTO capacity_providers (id, fingerprint, public_jwk_json, display_name, identity_version, status, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'active', '{}', ?, ?)`, ['provider-governed', 'sha256:provider-governed', JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'provider-governed', alg: 'EdDSA' }), 'Governed Provider', now, now]);
			await store.run(`INSERT INTO capacity_provider_team_memberships (id, team_id, capacity_provider_id, status, approved_at, approved_by_id, metadata_json, created_at, updated_at) VALUES (?, ?, ?, 'approved', ?, ?, '{}', ?, ?)`, ['membership-governed', 'team-governed', 'provider-governed', now, 'owner', now, now]);
			await store.run(`INSERT INTO capacity_execution_providers (id, capacity_provider_id, display_name, adapter, status, capabilities_json, native_unit, quota_visibility, max_concurrent_runners, native_limits_json, metadata_json, created_at, updated_at) VALUES ('codex', 'provider-governed', 'Codex', 'codex', 'active', '["engineering","repo_read","agent_mode_run"]', 'wall_minute', 'exact', 1, '[]', '{}', ?, ?)`, [now, now]);
			await store.run(`INSERT INTO treedx_instances (id, team_id, kind, provider, name, base_url, public_read, "primary", status, metadata_json, created_at, updated_at) VALUES (?, ?, 'local', 'local', 'Local TreeDX', 'http://127.0.0.1:4000', 0, 1, 'active', '{}', ?, ?)`, ['treedx-governed', 'team-governed', now, now]);
			await store.run(`INSERT INTO treedx_project_libraries (id, team_id, project_id, instance_id, library_id, repository_id, content_path, topology_json, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'docs/src/content', '{}', '{}', ?, ?)`, ['library-agent', 'team-governed', 'project-agent', 'treedx-governed', 'team-governed/agent', 'treeseed-agent', now, now]);

			const allocation = await store.createCapacityAllocationSet('team-governed', {
				id: 'allocation-governed', version: 1, status: 'draft', effectiveFrom,
				reservePolicy: { percent: 0, overflow: 'deny' },
				slices: [{ id: 'slice-agent', scope: 'project', targetId: 'project-agent', policy: { minPercent: 100, targetPercent: 100, maxPercent: 100, hardCapPercent: 100 } }],
				borrowingRules: [],
				idempotencyKey: 'governed-allocation-create',
			});
			await store.activateCapacityAllocationSet('team-governed', allocation.id, 'governed-allocation-activate');
			const grantService = new CapacityGrantService(store);
			const grant = await grantService.create('team-governed', {
				id: 'grant-governed', membershipId: 'membership-governed', projectId: 'project-agent', environment: 'local',
				executionProviderIds: ['codex'], laneIds: [], capabilities: ['repo_read', 'agent_mode_run'], allowedModes: ['planning'], unmetered: true,
			}, 'governed-grant-create');
			await grantService.transition('team-governed', grant!.id, 'active', 'governed-grant-activate');
			await store.run(`INSERT INTO project_agent_classes (id, team_id, project_id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ['class-native-accounting', 'team-governed', 'project-agent', 'native-accounting', 'Native Accounting', now, now]);
			await store.run(
				`INSERT INTO capacity_reservations (
					id, idempotency_key, admission_token, membership_id, grant_id, capacity_provider_id, execution_provider_id,
					allocation_set_id, allocation_version, project_agent_class_id, mode, team_id, project_id,
					state, reserved_credits, consumed_credits, native_unit, reserved_native_amount,
					consumed_native_amount, created_at, updated_at
				) VALUES
					(?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'planning', ?, ?, 'reserved', 2, 0, 'wall_minute', 10, NULL, ?, ?),
					(?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'planning', ?, ?, 'consumed', 2, 2, 'wall_minute', NULL, 15, ?, ?)`,
				[
					'native-reserved', 'native-reserved', 'native-reserved-token', 'membership-governed', grant!.id, 'provider-governed', 'codex', allocation.id,
					'class-native-accounting', 'team-governed', 'project-agent', '2026-07-17T03:00:00.000Z', '2026-07-17T03:00:00.000Z',
					'native-consumed', 'native-consumed', 'native-consumed-token', 'membership-governed', grant!.id, 'provider-governed', 'codex', allocation.id,
					'class-native-accounting', 'team-governed', 'project-agent', '2026-07-17T02:00:00.000Z', '2026-07-17T02:00:00.000Z',
				],
			);
			expect(await aggregateNativeReservationDebits(store, {
				teamId: 'team-governed', capacityProviderId: 'provider-governed', executionProviderId: 'codex',
				nativeUnit: 'wall_minute', providerNativeUnit: 'wall_minute', projectId: 'project-agent',
				windowStartAt: '2026-07-17T00:00:00.000Z', windowEndAt: '2026-07-18T00:00:00.000Z',
			})).toEqual({ activeReservedNativeAmount: 10, activeConsumedNativeAmount: 15 });
			expect(await store.getTeamCapacitySummary('team-governed', { now: '2026-07-17T04:00:00.000Z' })).toMatchObject({
				dailyUsedCredits: 2,
				dailyReservedCredits: 4,
				monthlyUsedCredits: 2,
				monthlyReservedCredits: 4,
			});
			const before = {
				grants: Number((await store.first(`SELECT COUNT(*) AS count FROM capacity_grants WHERE team_id = ?`, ['team-governed']))?.count ?? 0),
				allocations: Number((await store.first(`SELECT COUNT(*) AS count FROM capacity_allocation_sets WHERE team_id = ?`, ['team-governed']))?.count ?? 0),
			};

			const run = await store.createCapacityWorkdayRun('team-governed', {
				id: 'run-governed', capacityProviderId: 'provider-governed', environment: 'local', status: 'running',
				parameters: { projects: ['agent'], durationSeconds: 60, allocationSetId: allocation.id, availableCredits: 10 },
			});
			expect(run).toMatchObject({
				id: 'run-governed', status: 'running',
				parameters: {
					allocationSetId: allocation.id,
					scheduledProjectIds: ['project-agent'],
					scheduledProjectSlugs: ['agent'],
					repositoryIdsByProjectId: { 'project-agent': 'treeseed-agent' },
				},
			});
			expect(await store.getWorkdayCapacityEnvelope('workday-run-governed-agent')).toMatchObject({
				status: 'active', workdayRunId: 'run-governed', allocationSetId: allocation.id, metadata: { grantId: grant!.id },
			});
			expect({
				grants: Number((await store.first(`SELECT COUNT(*) AS count FROM capacity_grants WHERE team_id = ?`, ['team-governed']))?.count ?? 0),
				allocations: Number((await store.first(`SELECT COUNT(*) AS count FROM capacity_allocation_sets WHERE team_id = ?`, ['team-governed']))?.count ?? 0),
			}).toEqual(before);

			await store.updateCapacityWorkdayRun('team-governed', 'run-governed', { status: 'completed' });
			expect(await store.getWorkdayCapacityEnvelope('workday-run-governed-agent')).toMatchObject({ status: 'completed' });
			expect(await grantService.get('team-governed', grant!.id)).toMatchObject({ status: 'active' });
		} finally {
			db.close();
		}
	});

	it('records a failed run when required governance is absent', async () => {
		const { db, store } = createStore();
		try {
			await store.ensureInitialized();
			await store.createTeam({ id: 'team-no-policy', slug: 'team-no-policy', name: 'no-policy' });
			await expect(store.createCapacityWorkdayRun('team-no-policy', {
				id: 'run-no-policy', capacityProviderId: 'provider-missing', environment: 'local', status: 'running',
				parameters: { projects: ['agent'], durationSeconds: 60 },
			})).rejects.toMatchObject({ code: 'capacity_workday_membership_not_approved' });
			expect(await store.getCapacityWorkdayRun('team-no-policy', 'run-no-policy')).toMatchObject({
				status: 'failed', error: { code: 'capacity_workday_schedule_failed' },
			});
		} finally {
			db.close();
		}
	});

	it('persists workday runs and ordered audit events', async () => {
		const { db, store } = createStore();
		try {
			await store.ensureInitialized();
			await store.createTeam({
				id: 'team-test',
				slug: 'treeseed',
				name: 'TreeSeed',
			});

			const run = await store.createCapacityWorkdayRun('team-test', {
				id: 'run-test',
				capacityProviderId: 'provider-local',
				status: 'queued',
				parameters: { providerCredentialRef: 'secret://capacity/team-test', projects: ['market'], durationSeconds: 60 },
				expected: { projects: ['market'] },
			});
			expect(run).toMatchObject({
				id: 'run-test',
				teamId: 'team-test',
				status: 'queued',
				capacityProviderId: 'provider-local',
				parameters: { providerCredentialRef: 'secret://capacity/team-test', projects: ['market'], durationSeconds: 60, deadlineAt: null },
			});

			const first = await store.createCapacityWorkdayEvent('team-test', 'run-test', {
				eventType: 'command.started',
				title: 'Started',
				parameters: { projects: ['market'] },
			});
			const second = await store.createCapacityWorkdayEvent('team-test', 'run-test', {
				eventType: 'command.completed',
				status: 'completed',
				title: 'Completed',
			});
			const idempotent = await store.createCapacityWorkdayEvent('team-test', 'run-test', {
				id: 'event-idempotent', eventType: 'command.observed', status: 'recorded', title: 'Observed',
			});
			const repeated = await store.createCapacityWorkdayEvent('team-test', 'run-test', {
				id: 'event-idempotent', eventType: 'command.changed', status: 'error', title: 'Must not replace',
			});
			expect(first?.eventIndex).toBe(0);
			expect(second?.eventIndex).toBe(1);
			expect(idempotent).toMatchObject({ eventIndex: 2, eventType: 'command.observed', status: 'recorded' });
			expect(repeated).toEqual(idempotent);
			expect(await store.first(`SELECT next_event_index FROM capacity_workday_runs WHERE id = ?`, ['run-test'])).toMatchObject({ next_event_index: 3 });

			await store.updateCapacityWorkdayRun('team-test', 'run-test', { status: 'running' });
			const updated = await store.updateCapacityWorkdayRun('team-test', 'run-test', {
				status: 'completed',
				metrics: { score: 100 },
				reportRefs: { jsonPath: '.treeseed/workday-reports/workday-run-test.json' },
			});
			expect(updated).toMatchObject({
				status: 'completed',
				metrics: { score: 100 },
			});
			expect(updated?.completedAt).toBeTruthy();
			await expect(store.updateCapacityWorkdayRun('team-test', 'run-test', { status: 'running' }))
				.rejects.toMatchObject({ code: 'capacity_workday_run_transition_invalid' });
			expect(await store.getCapacityWorkdayRun('team-test', 'run-test')).toMatchObject({ status: 'completed' });

			const events = (await store.listCapacityWorkdayEventsPage('team-test', 'run-test', { limit: 200 })).items;
			expect(events.map((event) => event.eventType)).toEqual(['command.started', 'command.completed', 'command.observed']);
			const runs = (await store.listCapacityWorkdayRunsPage('team-test', { limit: 100 })).items;
			expect(runs.map((entry) => entry.id)).toEqual(['run-test']);
			await expect(store.createCapacityWorkdayRun('team-test', {
				id: 'run-with-secret',
				parameters: { providerToken: 'secret-value' },
			})).rejects.toMatchObject({ code: 'capacity_workday_secret_forbidden' });
			await expect(store.createCapacityWorkdayRun('team-test', {
				id: 'run-with-invalid-engineering-workflow',
				parameters: { engineeringWorkflows: [{ schemaVersion: 1, id: 'missing-provenance' }] },
			})).rejects.toMatchObject({ code: 'engineering_workflow_config_invalid', status: 400 });
		} finally {
			db.close();
		}
	});

	it('autonomously terminalizes an elapsed run with durable degraded evidence', async () => {
		const { db, store } = createStore();
		try {
			await store.ensureInitialized();
			await store.createTeam({ id: 'team-expiry', slug: 'expiry-team', name: 'expiry-team' });
			const startedAt = new Date(Date.now() + 60_000).toISOString();
			const deadlineAt = new Date(Date.parse(startedAt) + 60_000).toISOString();
			const terminalizedAt = new Date(Date.parse(deadlineAt) + 600_000).toISOString();
			await store.createCapacityWorkdayRun('team-expiry', {
				id: 'run-expiry',
				status: 'queued',
				startedAt,
				parameters: {
					deadlineAt,
					settlementGraceSeconds: 300,
				},
			});
			await store.updateCapacityWorkdayRun('team-expiry', 'run-expiry', {
				status: 'running',
				startedAt,
				parameters: { deadlineAt, settlementGraceSeconds: 300 },
			});

			const concurrent = await Promise.all([
				store.maintainCapacityWorkdayRuns('team-expiry', terminalizedAt),
				store.maintainCapacityWorkdayRuns('team-expiry', terminalizedAt),
			]);
			expect(concurrent.reduce((sum, result) => sum + result.expired, 0)).toBe(1);
			expect(await store.maintainCapacityWorkdayRuns('team-expiry', terminalizedAt)).toEqual({ expired: 0, recoveredTerminalRuns: 0 });
			const run = await store.getCapacityWorkdayRun('team-expiry', 'run-expiry');
			expect(run).toMatchObject({
				status: 'degraded',
				summary: { status: 'degraded', assignmentCount: 0 },
				metrics: { assignmentCompletionPercent: 0, modeRunSuccessPercent: 0 },
				actual: { assignmentCount: 0, contentArtifactCount: 0, deadlineTerminalizedAt: terminalizedAt },
				error: { code: 'workday_deadline_degraded' },
			});
			const events = (await store.listCapacityWorkdayEventsPage('team-expiry', 'run-expiry', { limit: 200 })).items;
			expect(events).toEqual([
				expect.objectContaining({ id: 'workday-deadline-admission:run-expiry', eventType: 'workday.deadline_admission_closed', status: 'warning' }),
				expect.objectContaining({ id: 'workday-deadline:run-expiry', eventType: 'workday.deadline_terminalized', status: 'warning' }),
			]);
		} finally {
			db.close();
		}
	});
});
