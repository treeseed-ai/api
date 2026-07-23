import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DataType, newDb } from 'pg-mem';
import { MarketControlPlaneStore } from '../../../src/api/store.js';
import { createCapacityControlPlane } from '../../../src/api/capacity/control-plane.ts';
import { MarketPostgresDatabase } from '../../../src/api/market-postgres.js';
import { CapacityGrantService } from '../../../src/api/capacity/services/grant-service.ts';
import { aggregateNativeReservationDebits } from '../../../src/api/capacity/services/native-reservation-aggregation-service.ts';
import { decodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
const packageRoot = process.cwd();
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
        await expect(store.run(`INSERT INTO workday_capacity_envelopes (id, team_id, project_id, status, created_at, updated_at) VALUES ('workday-invalid-status', 'team-constraints', 'project-constraints', 'running', ?, ?)`, [now, now])).rejects.toThrow(/check constraint/iu);
        await expect(store.run(`INSERT INTO workday_capacity_envelopes (id, team_id, project_id, status, created_at, updated_at) VALUES ('workday-invalid-project', 'team-constraints', 'missing-project', 'draft', ?, ?)`, [now, now])).rejects.toThrow(/foreign key/iu);
        await expect(store.run(`INSERT INTO agent_capacity_plans (id, team_id, project_id, decision_id, status, scope_hash, expected_credits, high_credits, created_at, updated_at) VALUES ('plan-invalid-credits', 'team-constraints', 'project-constraints', 'decision-a', 'draft', 'scope-a', 5, 4, ?, ?)`, [now, now])).rejects.toThrow(/check constraint/iu);
        await expect(store.run(`INSERT INTO agent_capacity_plans (id, team_id, project_id, decision_id, status, scope_hash, created_at, updated_at) VALUES ('plan-invalid-status', 'team-constraints', 'project-constraints', 'decision-a', 'approved', 'scope-a', ?, ?)`, [now, now])).rejects.toThrow(/check constraint/iu);
    }
    finally {
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
        await store.run(`UPDATE capacity_provider_assignments
				 SET status = 'completed', synthesized_from = 'workday_demand', metadata_json = '{"workdayRunId":"run-terminalization"}'
				 WHERE id = 'assignment-explanation'`);
        await store.run(`INSERT INTO capacity_reservations (
					id, idempotency_key, admission_token, membership_id, grant_id, capacity_provider_id,
					allocation_set_id, allocation_version, project_agent_class_id, assignment_id, mode,
					team_id, project_id, state, reserved_credits, created_at, updated_at
				) VALUES ('reservation-other', 'terminal-other', 'token-other', 'membership-explanation', 'grant-test',
					'provider-explanation', 'allocation-test', 1, 'class-explanation', 'assignment-other', 'planning',
					'team-explanation', 'project-explanation', 'reserved', 1, ?, ?)`, [now, now]);
        await store.run(`UPDATE capacity_provider_assignments
				 SET status = 'pending', reservation_id = 'reservation-other', synthesized_from = 'workday_demand', metadata_json = '{"workdayRunId":"run-terminalization"}'
				 WHERE id = 'assignment-other'`);
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
    }
    finally {
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
            reservationValues.push(`reservation-batched-${suffix}`, `terminal-batched-${suffix}`, `token-batched-${suffix}`, `assignment-batched-${suffix}`, now, now);
            return `(?, ?, ?, 'membership-batched-terminal', 'grant-test', 'provider-batched-terminal',
					'allocation-test', 1, 'class-batched-terminal', ?, 'planning', 'team-batched-terminal',
					'project-batched-terminal', 'workday-batched-summary', 'reserved', 1, ?, ?)`;
        });
        await store.run(`INSERT INTO capacity_reservations (
					id, idempotency_key, admission_token, membership_id, grant_id, capacity_provider_id,
					allocation_set_id, allocation_version, project_agent_class_id, assignment_id, mode,
					team_id, project_id, work_day_id, state, reserved_credits, created_at, updated_at
				) VALUES ${reservationRows.join(', ')}`, reservationValues);
        const assignmentValues = [];
        const assignmentRows = Array.from({ length: assignmentCount }, (_, index) => {
            const suffix = String(index).padStart(3, '0');
            assignmentValues.push(`assignment-batched-${suffix}`, 'membership-batched-terminal', 'team-batched-terminal', 'project-batched-terminal', 'provider-batched-terminal', 'class-batched-terminal', `reservation-batched-${suffix}`, 'workday-batched-summary', now, now);
            return `(?, ?, ?, ?, ?, ?, ?, 'planning', ?, 'pending', 'workday_demand',
					'{"teamId":"team-batched-terminal","projectId":"project-batched-terminal","mode":"planning"}',
					'{"teamId":"team-batched-terminal","projectId":"project-batched-terminal","projectAgentClassId":"class-batched-terminal","mode":"planning","input":{}}',
					'{"workdayRunId":"run-batched-terminal"}', ?, ?)`;
        });
        await store.run(`INSERT INTO capacity_provider_assignments (
					id, membership_id, team_id, project_id, capacity_provider_id, project_agent_class_id,
					reservation_id, mode, work_day_id, status, synthesized_from, capacity_envelope_json,
					decision_input_json, metadata_json, created_at, updated_at
				) VALUES ${assignmentRows.join(', ')}`, assignmentValues);
        const demandValues = [];
        const demandRows = Array.from({ length: assignmentCount }, (_, index) => {
            const suffix = String(index).padStart(3, '0');
            demandValues.push(`demand-batched-${suffix}`, `source-${suffix}`, `demand-key-${suffix}`, `assignment-batched-${suffix}`, now, now, now, now);
            return `(?, 'team-batched-terminal', 'project-batched-terminal', 'run-batched-terminal', 'workday-batched-summary',
				 'idle-intent', ?, 'planning', 'class-batched-terminal', 'researcher', 'writer', 'planning', 'admitted', 1, 1, ?, ?, '{}', '{}', ?, ?, ?, ?)`;
        });
        await store.run(`INSERT INTO capacity_workday_demands (id, team_id, project_id, workday_run_id, workday_id, source_type, source_id, mode, project_agent_class_id, agent_id, handler_id, activity_type, status, priority, requested_credits, idempotency_key, assignment_id, payload_json, metadata_json, available_at, admitted_at, created_at, updated_at) VALUES ${demandRows.join(', ')}`, demandValues);
        const terminalization = await store.terminalizeCapacityWorkdayAssignments('team-batched-terminal', 'run-batched-terminal', { now });
        expect(terminalization).toMatchObject({
            assignmentCount,
            completedAssignments: 0,
            failedAssignments: assignmentCount,
            unfinishedAssignmentCount: 0,
            settlementErrorCount: 0,
            settlementErrorsTruncated: false,
        });
        expect(terminalization.settlementErrors).toEqual([]);
        expect(Number((await store.first(`SELECT COUNT(*) AS count FROM capacity_provider_assignments WHERE team_id = ? AND status = 'failed'`, ['team-batched-terminal']))?.count ?? 0)).toBe(assignmentCount);
        expect(Number((await store.first(`SELECT COUNT(*) AS count FROM capacity_reservations WHERE team_id = ? AND state = 'consumed'`, ['team-batched-terminal']))?.count ?? 0)).toBe(assignmentCount);
        const modeRunValues = [];
        const modeRunRows = Array.from({ length: assignmentCount }, (_, index) => {
            modeRunValues.push(`mode-batched-${String(index).padStart(3, '0')}`, 'team-batched-terminal', 'project-batched-terminal', `assignment-batched-${String(index).padStart(3, '0')}`, 'provider-batched-terminal', 'class-batched-terminal', now, now);
            return `(?, ?, ?, ?, ?, ?, 'planning', 'succeeded',
					'{"teamId":"team-batched-terminal","projectId":"project-batched-terminal","mode":"planning"}', ?, ?)`;
        });
        await store.run(`INSERT INTO agent_mode_runs (
					id, team_id, project_id, provider_assignment_id, capacity_provider_id,
					project_agent_class_id, mode, status, capacity_envelope_json, created_at, updated_at
				) VALUES ${modeRunRows.join(', ')}`, modeRunValues);
        const fallbackValues = [];
        const fallbackRows = Array.from({ length: 51 }, (_, index) => {
            fallbackValues.push(`fallback-batched-${String(index).padStart(3, '0')}`, 'team-batched-terminal', 'project-batched-terminal', `assignment-batched-${String(index).padStart(3, '0')}`, now);
            return `(?, ?, ?, ?, 'planning', 'planning_input_unavailable', 'emitted', '{}', '{}', '{}', '{}', ?)`;
        });
        await store.run(`INSERT INTO agent_fallback_outputs (
					id, team_id, project_id, assignment_id, mode, code, status,
					output_json, provenance_json, quota_json, metadata_json, created_at
				) VALUES ${fallbackRows.join(', ')}`, fallbackValues);
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
    }
    finally {
        db.close();
    }
});
});
