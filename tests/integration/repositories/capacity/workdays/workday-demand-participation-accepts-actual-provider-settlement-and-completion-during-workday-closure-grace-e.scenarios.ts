import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType,newDb } from 'pg-mem';
import { describe,expect,it,vi } from 'vitest';
import { createCapacityControlPlane } from '../../../../../src/api/capacity/control-plane.ts';
import { CapacityWorkdayDemandRepository } from '../../../../../src/api/capacity/repositories/capacity/workdays/workday-demand.ts';
import { evaluateProviderAssignmentLeaseAuthority } from '../../../../../src/api/capacity/services/accounts/lease-authority-service.ts';
import { settleCapacityReservationExactlyOnce } from '../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts';
import { CapacityAllocationService } from '../../../../../src/api/capacity/services/capacity/allocations/allocation-service.ts';
import { CapacityGrantService } from '../../../../../src/api/capacity/services/capacity/allocations/grant-service.ts';
import { ProviderAssignmentLifecycleService } from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-lifecycle-service.ts';
import { OperatorAssignmentService } from '../../../../../src/api/capacity/services/capacity/assignments/observability/operator-assignment-service.ts';
import { assignNextCompiledDemand } from '../../../../../src/api/capacity/services/capacity/assignments/planning/assignment-function.ts';
import { tickCapacityWorkdayRun } from '../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-tick-service.ts';
import { compileWorkdayPlanningGraphSnapshot } from '../../../../../src/api/capacity/services/capacity/workdays/policy/workday-planning-graph-policy.ts';
import { ControlPlaneStore } from '../../../../../src/api/persistence/store.ts';
import { ControlPlanePostgresDatabase } from '../../../../../src/api/support/control-plane-postgres.ts';
const packageRoot = process.cwd();
const migrationRoot = resolve(packageRoot, 'drizzle/control-plane');
function harness() {
    const memory = newDb();
	memory.public.registerFunction({ name: "replace", args: [DataType.text, DataType.text, DataType.text], returns: DataType.text, implementation: (value: string, search: string, replacement: string) => value.split(search).join(replacement) });
    memory.public.registerFunction({ name: 'md5', args: [DataType.text], returns: DataType.text, implementation: (value: string) => `md5:${value}` });
    const pg = memory.adapters.createPg();
    const database = ControlPlanePostgresDatabase.fromPool(new pg.Pool(), { migrationRoot });
    const store = new ControlPlaneStore({
        repoRoot: packageRoot, authSecret: 'demand-test-auth-secret', assertionSecret: 'demand-test-assertion-secret',
        serviceId: 'web', serviceSecret: 'demand-test-service-secret',
    }, database);
    return { database, store };
}
async function seed(database: ControlPlaneStore) {
    const now = '2026-07-18T12:00:00.000Z';
    await database.ensureInitialized();
    await database.run(`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team-a', 'team-a', 'Team A', ?, ?)`, [now, now]);
    await database.run(`INSERT INTO projects (id, team_id, slug, name, metadata_json, created_at, updated_at) VALUES ('project-a', 'team-a', 'project-a', 'Project A', '{"architecture":{"topology":"single_repository_site","rootPath":".","sitePath":".","contentPath":"src/content","contentRuntimeSource":"local_directory","localContentMaterialization":"existing_path"}}', ?, ?)`, [now, now]);
    await database.run(`INSERT INTO project_agent_classes (id, team_id, project_id, slug, name, allowed_modes_json, handler_refs_json, created_at, updated_at) VALUES ('class-a', 'team-a', 'project-a', 'planner', 'Planner', '["planning"]', ?, ?, ?)`, [JSON.stringify({ agents: [{ slug: 'architect', activities: { planning: { handler: 'writer', purpose: 'Plan the project architecture.', planningPriority: 1 } } }] }), now, now]);
    const planningGraph = compileWorkdayPlanningGraphSnapshot([{ id: 'class-a', slug: 'planner', status: 'active', allowedModes: ['planning'], handlerRefs: { agents: [{ slug: 'architect', activities: { planning: { handler: 'writer', purpose: 'Plan the project architecture.', planningPriority: 1 } } }] } }], {});
    await database.run(`INSERT INTO capacity_workday_runs (id, team_id, capacity_provider_id, scenario_id, status, environment, parameters_json, started_at, created_at, updated_at) VALUES ('run-a', 'team-a', 'provider-a', 'real planning', 'running', 'local', ?, ?, ?, ?)`, [JSON.stringify({ projects: ['project-a'], planningGraphByProjectId: { 'project-a': planningGraph } }), now, now, now]);
    await database.run(`INSERT INTO workday_capacity_envelopes (id, team_id, project_id, workday_run_id, status, envelope_json, metadata_json, started_at, created_at, updated_at) VALUES ('workday-a', 'team-a', 'project-a', 'run-a', 'active', '{"availableSeconds":10}', '{}', ?, ?, ?)`, [now, now, now]);
    return now;
}
async function seedAdmittedAssignment(database: ControlPlaneStore, status: 'pending' | 'leased' | 'failed' = 'pending') {
    const now = await seed(database);
    const leased = status === 'leased';
    await database.run(`INSERT INTO capacity_providers (id, fingerprint, public_jwk_json, display_name, identity_version, status, metadata_json, created_at, updated_at) VALUES ('provider-a', 'sha256:provider-a', '{}', 'Provider A', 1, 'active', '{}', ?, ?)`, [now, now]);
    await database.run(`INSERT INTO capacity_execution_providers (id, capacity_provider_id, display_name, adapter, status, capabilities_json, native_unit, quota_visibility, max_concurrent_runners, native_limits_json, metadata_json, created_at, updated_at) VALUES ('codex', 'provider-a', 'Codex', 'codex', 'active', '["engineering"]', 'wall_minute', 'exact', 2, '[]', '{}', ?, ?)`, [now, now]);
    await database.run(`INSERT INTO capacity_provider_team_memberships (id, team_id, capacity_provider_id, status, approved_at, approved_by_id, metadata_json, created_at, updated_at) VALUES ('membership-a', 'team-a', 'provider-a', 'approved', ?, 'owner', '{}', ?, ?)`, [now, now, now]);
    await database.run(`INSERT INTO capacity_allocation_sets (id, team_id, version, status, effective_from, reserve_policy_json, slices_json, borrowing_rules_json, metadata_json, created_at, updated_at) VALUES ('allocation-a', 'team-a', 1, 'active', ?, '{}', '[]', '[]', '{}', ?, ?)`, [now, now, now]);
    await database.run(`INSERT INTO capacity_grants (id, membership_id, capacity_provider_id, team_id, project_id, environment, status, capabilities_json, allowed_modes_json, daily_agent_seconds_limit, metadata_json, created_at, updated_at) VALUES ('grant-a', 'membership-a', 'provider-a', 'team-a', 'project-a', 'local', 'active', '[]', '["planning"]', 10, '{}', ?, ?)`, [now, now]);
    await database.run(`INSERT INTO capacity_reservations (id, idempotency_key, admission_token, membership_id, grant_id, capacity_provider_id, allocation_set_id, allocation_version, project_agent_class_id, assignment_id, mode, team_id, project_id, work_day_id, state, requested_seconds, reserved_seconds, created_at, updated_at) VALUES ('reservation-a', 'reservation-a', 'token-a', 'membership-a', 'grant-a', 'provider-a', 'allocation-a', 1, 'class-a', 'assignment-a', 'planning', 'team-a', 'project-a', 'workday-a', 'reserved', 1, 1, ?, ?)`, [now, now]);
    await database.run(`INSERT INTO capacity_provider_assignments (id, membership_id, team_id, project_id, capacity_provider_id, execution_provider_id, project_agent_class_id, reservation_id, work_day_id, mode, status, lease_state, lease_token, lease_expires_at, state_version, capacity_envelope_json, decision_input_json, synthesized_from, created_at, updated_at) VALUES ('assignment-a', 'membership-a', 'team-a', 'project-a', 'provider-a', 'codex', 'class-a', 'reservation-a', 'workday-a', 'planning', ?, ?, ?, ?, 2, '{"teamId":"team-a","projectId":"project-a","mode":"planning"}', '{"teamId":"team-a","projectId":"project-a","projectAgentClassId":"class-a","mode":"planning","input":{}}', 'workday_demand', ?, ?)`, [status, leased ? 'leased' : 'unleased', leased ? 'lease-a' : null, leased ? '2099-01-01T00:00:00.000Z' : null, now, now]);
    await database.run(`INSERT INTO capacity_workday_demands (id, team_id, project_id, workday_run_id, workday_id, source_type, source_id, mode, project_agent_class_id, agent_id, handler_id, activity_type, status, priority, requested_seconds, idempotency_key, claim_token, assignment_id, payload_json, metadata_json, available_at, claimed_at, admitted_at, created_at, updated_at) VALUES ('demand-a', 'team-a', 'project-a', 'run-a', 'workday-a', 'idle-intent', 'architect', 'planning', 'class-a', 'architect', 'writer', 'planning', 'admitted', 1, 1, 'demand-a', 'claim-a', 'assignment-a', '{"repositoryId":"treeseed-project-a","contentRoot":"src/content","intent":{"objective":"Recover the admitted work."}}', '{"environment":"local"}', ?, ?, ?, ?, ?)`, [now, now, now, now, now]);
    return now;
}

describe('durable workday demand and participation', () => {
it('accepts actual provider settlement and completion during workday closure grace exactly once', async () => {
    const { database, store } = harness();
    try {
        await seedAdmittedAssignment(store, 'leased');
        const controlPlane = createCapacityControlPlane(store);
        await expect(controlPlane.terminalizeCapacityWorkdayAssignments('team-a', 'run-a', {
            now: '2026-07-18T12:01:00.000Z', preserveActiveLeasesUntil: '2099-01-01T00:05:00.000Z',
        })).resolves.toMatchObject({ unfinishedAssignmentCount: 1, deferredActiveAssignmentCount: 1 });
        await settleCapacityReservationExactlyOnce(store, {
            settlementKey: 'provider-actual-a', teamId: 'team-a', membershipId: 'membership-a',
            reservationId: 'reservation-a', assignmentId: 'assignment-a', activeSeconds: 1, elapsedSeconds: 1,
            source: 'provider_usage_report', existingSettlementPolicy: 'replay',
        });
        await expect(controlPlane.completeProviderAssignment({ teamId: 'team-a', membershipId: 'membership-a', capacityProviderId: 'provider-a' }, 'assignment-a', { leaseToken: 'lease-a', code: 'provider_assignment_completed' })).resolves.toMatchObject({ assignment: { status: 'completed' } });
        await expect(controlPlane.terminalizeCapacityWorkdayAssignments('team-a', 'run-a', {
            now: '2100-01-01T00:00:00.000Z', preserveActiveLeasesUntil: '2099-01-01T00:05:00.000Z',
        })).resolves.toMatchObject({ completedAssignments: 1, failedAssignments: 0, unfinishedAssignmentCount: 0 });
        expect(await store.all(`SELECT source, active_seconds FROM capacity_ledger_entries WHERE reservation_id = 'reservation-a'`)).toEqual([{ source: 'provider_usage_report', active_seconds: 1 }]);
        expect(await store.first(`SELECT state, active_seconds FROM capacity_reservations WHERE id = 'reservation-a'`)).toEqual({ state: 'consumed', active_seconds: 1 });
    }
    finally {
        await database.close();
    }
});

it('ticks idempotently without creating duplicate durable demand', async () => {
    const { database, store } = harness();
    try {
        const now = await seed(store);
        await store.run(`INSERT INTO capacity_providers (id, fingerprint, public_jwk_json, display_name, identity_version, status, metadata_json, created_at, updated_at) VALUES ('provider-a', 'sha256:provider-a', '{}', 'Provider A', 1, 'active', '{}', ?, ?)`, [now, now]);
        await store.run(`INSERT INTO capacity_provider_team_memberships (id, team_id, capacity_provider_id, status, approved_at, approved_by_id, metadata_json, created_at, updated_at) VALUES ('membership-a', 'team-a', 'provider-a', 'approved', ?, 'owner', '{}', ?, ?)`, [now, now, now]);
        await store.run(`INSERT INTO capacity_provider_availability_sessions (id, membership_id, team_id, capacity_provider_id, environment, status, opened_at, refreshed_at, expires_at, available_from, execution_providers_json, metadata_json, created_at, updated_at) VALUES ('session-a', 'membership-a', 'team-a', 'provider-a', 'local', 'open', ?, ?, '2099-01-01T00:00:00.000Z', ?, '[{"id":"codex","status":"available","capabilities":["writer"],"availableConcurrency":1,"maxConcurrentRunners":1}]', '{}', ?, ?)`, [now, now, now, now, now]);
        const first = await tickCapacityWorkdayRun(createCapacityControlPlane(store), 'team-a', 'run-a', now, 'tick-a');
        const second = await tickCapacityWorkdayRun(createCapacityControlPlane(store), 'team-a', 'run-a', '2026-07-18T12:01:00.000Z', 'tick-a');
        expect(first.compilation).toEqual({ consideredRuns: 1, compiledDemands: 1 });
        expect(second).toEqual(first);
        expect(await store.all(`SELECT id FROM capacity_workday_demands`)).toHaveLength(1);
        expect(await store.all(`SELECT event_type FROM capacity_workday_events WHERE event_type = 'workday.tick'`)).toEqual([{ event_type: 'workday.tick' }]);
    }
    finally {
        await database.close();
    }
});

it('rejects cancellation while leased and safely settles an unleased cancellation once', async () => {
    const leasedHarness = harness();
    try {
        await seedAdmittedAssignment(leasedHarness.store, 'leased');
        await expect(new OperatorAssignmentService(leasedHarness.store).cancel('team-a', 'assignment-a', { idempotencyKey: 'cancel-a' }))
            .rejects.toMatchObject({ code: 'capacity_assignment_active_lease_conflict', status: 409 });
        expect(await leasedHarness.store.first(`SELECT state FROM capacity_reservations WHERE id = 'reservation-a'`)).toEqual({ state: 'reserved' });
    }
    finally {
        await leasedHarness.database.close();
    }
    const pendingHarness = harness();
    try {
        await seedAdmittedAssignment(pendingHarness.store, 'pending');
        const service = new OperatorAssignmentService(pendingHarness.store);
        await expect(service.cancel('team-a', 'assignment-a', { idempotencyKey: 'cancel-a' })).resolves.toMatchObject({ status: 'cancelled', leaseState: 'released' });
        await expect(service.cancel('team-a', 'assignment-a', { idempotencyKey: 'cancel-a' })).resolves.toMatchObject({ status: 'cancelled' });
        expect(await pendingHarness.store.all(`SELECT phase, active_seconds FROM capacity_ledger_entries WHERE reservation_id = 'reservation-a'`)).toEqual([{ phase: 'task_completed_actual_settlement', active_seconds: 0 }]);
        expect(await pendingHarness.store.first(`SELECT state, active_seconds FROM capacity_reservations WHERE id = 'reservation-a'`)).toEqual({ state: 'consumed', active_seconds: 0 });
    }
    finally {
        await pendingHarness.database.close();
    }
});

it('allows an operator to resolve an expired assignment and its stranded reservation', async () => {
    const expiredHarness = harness();
    try {
        const now = await seedAdmittedAssignment(expiredHarness.store, 'failed');
        const proxyHandle = { id: 'tdx-assignment-a', projectId: 'project-a', repositoryId: 'treeseed-project-a', workspaceId: 'workspace-a', status: 'issued' };
        const capabilityHandles = { repository: [{ id: 'repository-a', status: 'active' }], treeDx: [{ id: 'treedx-a', status: 'active' }] };
        await expiredHarness.store.run(`UPDATE capacity_provider_assignments SET treedx_proxy_handle_json = ?, workspace_context_json = ? WHERE id = 'assignment-a'`, [
            JSON.stringify(proxyHandle), JSON.stringify({ treedxProxyHandle: proxyHandle, capabilityHandles }),
        ]);
        await expiredHarness.store.run(`INSERT INTO treedx_proxy_handles (id, team_id, project_id, assignment_id, repository_id, workspace_id, status, scopes_json, allowed_operations_json, allowed_paths_json, metadata_json, issued_at, created_at, updated_at) VALUES ('tdx-assignment-a', 'team-a', 'project-a', 'assignment-a', 'treeseed-project-a', 'workspace-a', 'issued', '[]', '[]', '[]', '{}', ?, ?, ?)`, [now, now, now]);
        await expiredHarness.store.run(`UPDATE capacity_provider_assignments
				 SET status = 'expired', lease_state = 'expired', lifecycle_code = 'expired_lease_side_effect_evidence_present'
				 WHERE id = 'assignment-a'`);
        const service = new OperatorAssignmentService(expiredHarness.store);
        await expect(service.cancel('team-a', 'assignment-a', {
            idempotencyKey: 'cancel-expired-a',
            reason: 'Operator reviewed and abandoned the expired attempt.',
        })).resolves.toMatchObject({
            status: 'cancelled', leaseState: 'released',
            treedxProxyHandle: { status: 'revoked' },
            capabilityHandles: {
                repository: [{ status: 'revoked' }],
                treeDx: [{ status: 'revoked' }],
            },
        });
        expect(await expiredHarness.store.first(`SELECT state, active_seconds FROM capacity_reservations WHERE id = 'reservation-a'`)).toEqual({ state: 'consumed', active_seconds: 0 });
        expect(await expiredHarness.store.first(`SELECT status FROM treedx_proxy_handles WHERE assignment_id = 'assignment-a'`)).toEqual({ status: 'revoked' });
    }
    finally {
        await expiredHarness.database.close();
    }
});

it('cleans a released failed assignment without rewriting its truthful outcome', async () => {
    const failedHarness = harness();
    try {
        const now = await seedAdmittedAssignment(failedHarness.store, 'failed');
        const proxyHandle = { id: 'tdx-assignment-a', projectId: 'project-a', repositoryId: 'treeseed-project-a', workspaceId: 'workspace-a', status: 'issued' };
        await failedHarness.store.run(`UPDATE capacity_provider_assignments SET status = 'failed', lease_state = 'released', treedx_proxy_handle_json = ?, workspace_context_json = ? WHERE id = 'assignment-a'`, [
            JSON.stringify(proxyHandle), JSON.stringify({ treedxProxyHandle: proxyHandle }),
        ]);
        await failedHarness.store.run(`INSERT INTO treedx_proxy_handles (id, team_id, project_id, assignment_id, repository_id, workspace_id, status, scopes_json, allowed_operations_json, allowed_paths_json, metadata_json, issued_at, created_at, updated_at) VALUES ('tdx-assignment-a', 'team-a', 'project-a', 'assignment-a', 'treeseed-project-a', 'workspace-a', 'issued', '[]', '[]', '[]', '{}', ?, ?, ?)`, [now, now, now]);
        const closeWorkspace = vi.fn(async () => undefined);
        const service = new OperatorAssignmentService(failedHarness.store, closeWorkspace);
        await expect(service.cancel('team-a', 'assignment-a', {
            idempotencyKey: 'cleanup-failed-a', reason: 'Remove terminal residue.',
        })).resolves.toMatchObject({ status: 'failed', leaseState: 'released', treedxProxyHandle: { status: 'revoked' } });
        expect(closeWorkspace).toHaveBeenCalledOnce();
        expect(await failedHarness.store.first(`SELECT status FROM treedx_proxy_handles WHERE assignment_id = 'assignment-a'`)).toEqual({ status: 'revoked' });
    }
    finally { await failedHarness.database.close(); }
});

it('preserves renewal authority for a valid lease while its completed workday settles', async () => {
    const { database, store } = harness();
    try {
        const now = await seedAdmittedAssignment(store, 'leased');
        await store.run(`UPDATE workday_capacity_envelopes SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = 'workday-a'`, [now, now]);
        const principal = { membershipId: 'membership-a', teamId: 'team-a', capacityProviderId: 'provider-a' };
        const completed = await evaluateProviderAssignmentLeaseAuthority(store, principal, 'assignment-a', now);
        expect(completed.reasons).not.toContain('workday_not_active');
        expect(completed.gates).toMatchObject({ workdayStatus: 'completed', validCompletedWorkdayLease: true });
        await store.run(`UPDATE workday_capacity_envelopes SET status = 'cancelled', updated_at = ? WHERE id = 'workday-a'`, [now]);
        expect((await evaluateProviderAssignmentLeaseAuthority(store, principal, 'assignment-a', now)).reasons).toContain('workday_not_active');
    }
    finally {
        await database.close();
    }
});

it('revokes durable TreeDX and capability handles when a leased assignment completes', async () => {
    const { database, store } = harness();
    try {
        const now = await seedAdmittedAssignment(store, 'leased');
        const proxyHandle = {
            id: 'tdx-assignment-a', projectId: 'project-a', repositoryId: 'treeseed-project-a',
            workspaceId: 'workspace-a', status: 'issued',
        };
        const capabilityHandles = {
            repository: [{ id: 'repository-a', status: 'active' }],
            treeDx: [{ id: 'treedx-a', status: 'active' }],
            workflowOperations: [{ id: 'workflow-a', status: 'active' }],
            secrets: [{ id: 'secret-a', status: 'active' }],
        };
        await store.run(`UPDATE capacity_provider_assignments SET treedx_proxy_handle_json = ?, workspace_context_json = ? WHERE id = 'assignment-a'`, [
            JSON.stringify(proxyHandle), JSON.stringify({ treedxProxyHandle: proxyHandle, capabilityHandles }),
        ]);
        await store.run(`INSERT INTO treedx_proxy_handles (id, team_id, project_id, assignment_id, repository_id, workspace_id, status, scopes_json, allowed_operations_json, allowed_paths_json, metadata_json, issued_at, created_at, updated_at) VALUES ('tdx-assignment-a', 'team-a', 'project-a', 'assignment-a', 'treeseed-project-a', 'workspace-a', 'issued', '[]', '[]', '[]', '{}', ?, ?, ?)`, [now, now, now]);
        await settleCapacityReservationExactlyOnce(store, {
            settlementKey: 'complete-before-terminal-release', teamId: 'team-a', membershipId: 'membership-a',
            reservationId: 'reservation-a', assignmentId: 'assignment-a', activeSeconds: 1, elapsedSeconds: 1, source: 'test',
        });
        const result = await new ProviderAssignmentLifecycleService(createCapacityControlPlane(store)).complete({ membershipId: 'membership-a', teamId: 'team-a', capacityProviderId: 'provider-a' }, 'assignment-a', { leaseToken: 'lease-a', output: {} });
        expect(result).toMatchObject({ assignment: { status: 'completed', leaseState: 'released' } });
        expect(await store.first(`SELECT status, revoked_at FROM treedx_proxy_handles WHERE id = 'tdx-assignment-a'`))
            .toEqual({ status: 'revoked', revoked_at: expect.any(String) });
        const terminal = await createCapacityControlPlane(store).getProviderAssignment('team-a', 'assignment-a');
        expect(terminal?.treedxProxyHandle).toMatchObject({ id: 'tdx-assignment-a', status: 'revoked', revokedAt: expect.any(String) });
		expect(terminal?.metadata).toMatchObject({ operationalState: 'completed' });
        for (const handles of Object.values(terminal?.capabilityHandles ?? {})) {
            expect(handles).toEqual([expect.objectContaining({ status: 'revoked', revokedAt: expect.any(String) })]);
        }
    }
    finally {
        await database.close();
    }
});

it('requeues a terminal assignment as one durable demand without directly creating an assignment', async () => {
    const { database, store } = harness();
    try {
        await seedAdmittedAssignment(store, 'failed');
        await settleCapacityReservationExactlyOnce(store, {
            settlementKey: 'failed-before-requeue',
            teamId: 'team-a',
            membershipId: 'membership-a',
            reservationId: 'reservation-a',
            assignmentId: 'assignment-a',
            activeSeconds: 0, elapsedSeconds: 0,
            source: 'test_terminal_assignment',
            existingSettlementPolicy: 'replay',
        });
        const service = new OperatorAssignmentService(store);
        const first = await service.requeue('team-a', 'assignment-a', { idempotencyKey: 'retry-a' });
        const second = await service.requeue('team-a', 'assignment-a', { idempotencyKey: 'retry-a' });
        expect(first).toMatchObject({ alreadyLeasable: false, demand: { status: 'pending', metadata: { requeuedFromAssignmentId: 'assignment-a' } } });
        expect(second).toMatchObject({ demand: { id: first.demand?.id } });
        expect(await store.all(`SELECT id FROM capacity_provider_assignments`)).toHaveLength(1);
        expect(await store.all(`SELECT id FROM capacity_workday_demands`)).toHaveLength(2);
    }
    finally {
        await database.close();
    }
});

it('recovers interrupted post-admission workspace provisioning before any new demand can be assigned', async () => {
    const { database, store } = harness();
    try {
        const now = await seedAdmittedAssignment(store, 'pending');
		await store.run(`UPDATE capacity_provider_assignments SET workspace_context_json = ? WHERE id = 'assignment-a'`, [
			JSON.stringify({
				workspaceAccessMode: 'workspace_write',
				project: { id: 'project-a', slug: 'project-a' },
				capabilityHandles: { repository: [{ id: 'repository-a', status: 'active' }] },
			}),
		]);
        await store.run(`INSERT INTO treedx_proxy_handles (id, team_id, project_id, assignment_id, repository_id, workspace_id, status, scopes_json, allowed_operations_json, allowed_paths_json, metadata_json, issued_at, created_at, updated_at) VALUES ('tdx-assignment-a', 'team-a', 'project-a', 'assignment-a', 'treeseed-project-a', 'workspace-a', 'provisioning', '["files:read"]', '["files:read"]', '["**"]', '{}', ?, ?, ?)`, [now, now, now]);
        const principal = { membershipId: 'membership-a', teamId: 'team-a', capacityProviderId: 'provider-a' };
        expect((await evaluateProviderAssignmentLeaseAuthority(store, principal, 'assignment-a', now)).reasons).toContain('assignment_workspace_not_ready');
        const controlPlane = createCapacityControlPlane(store);
        let workspaceCreates = 0;
        (controlPlane as unknown as {
            createCapacityWorkdayTreeDxWorkspace: (...args: unknown[]) => Promise<Record<string, unknown>>;
        }).createCapacityWorkdayTreeDxWorkspace = async () => {
            workspaceCreates += 1;
            return { workspaceId: 'workspace-a', baseCommitSha: 'a'.repeat(40), baseRef: 'refs/heads/main', branchName: 'refs/heads/assignment-a' };
        };
        await expect(assignNextCompiledDemand(controlPlane, principal, 'session-a', [{ id: 'codex', status: 'available', capabilities: ['engineering'], maxConcurrentRunners: 1,
			lanes: [{ id: 'codex-operation', purpose: 'operation', maxConcurrentRunners: 1, capabilities: ['engineering'] }] }], now)).resolves.toBeNull();
        expect(workspaceCreates).toBe(1);
        const handle = await store.first(`SELECT status, metadata_json FROM treedx_proxy_handles WHERE assignment_id = 'assignment-a'`);
        expect(handle?.status).toBe('issued');
        expect(JSON.parse(String(handle?.metadata_json))).toMatchObject({
            baseCommitSha: 'a'.repeat(40), baseRef: 'refs/heads/main', branchName: 'refs/heads/assignment-a',
        });
        const persisted = await controlPlane.getProviderAssignment('team-a', 'assignment-a');
        expect(persisted?.treedxProxyHandle).toMatchObject({
            status: 'issued', baseCommitSha: 'a'.repeat(40), baseRef: 'refs/heads/main', branchName: 'refs/heads/assignment-a',
        });
		expect(persisted?.workspaceContext).toMatchObject({
			workspaceAccessMode: 'workspace_write',
			project: { id: 'project-a', slug: 'project-a' },
			capabilityHandles: { repository: [{ id: 'repository-a', status: 'active' }] },
			treedxProxyHandle: { baseCommitSha: 'a'.repeat(40) },
		});
        expect((await evaluateProviderAssignmentLeaseAuthority(store, principal, 'assignment-a', now)).reasons).not.toContain('assignment_workspace_not_ready');
    }
    finally {
        await database.close();
    }
});

it('admits one assignment and creates one workspace under simultaneous complete assignment-function polls', async () => {
    const { database, store } = harness();
    try {
        await seed(store);
		const now = new Date().toISOString();
        await store.run(`UPDATE project_agent_classes SET required_capabilities_json = '["engineering"]' WHERE id = 'class-a'`);
        await store.run(`INSERT INTO capacity_providers (id, fingerprint, public_jwk_json, display_name, identity_version, status, metadata_json, created_at, updated_at) VALUES ('provider-a', 'sha256:provider-a', '{}', 'Provider A', 1, 'active', '{}', ?, ?)`, [now, now]);
        await store.run(`INSERT INTO capacity_provider_team_memberships (id, team_id, capacity_provider_id, status, approved_at, approved_by_id, metadata_json, created_at, updated_at) VALUES ('membership-a', 'team-a', 'provider-a', 'approved', ?, 'owner', '{}', ?, ?)`, [now, now, now]);
        const principal = { membershipId: 'membership-a', teamId: 'team-a', capacityProviderId: 'provider-a' };
        const controlPlane = createCapacityControlPlane(store);
        const session = await controlPlane.createProviderAvailabilitySession(principal, {
            id: 'session-a', environment: 'local', capabilities: ['engineering'],
            executionProviders: [{ id: 'codex', adapter: 'codex', status: 'available', capabilities: ['engineering'], maxConcurrentRunners: 2,
                lanes: [{ id: 'codex-operation', purpose: 'operation', maxConcurrentRunners: 1, capabilities: ['engineering'] }],
                nativeLimits: { availableAgentSeconds: 10 } }],
            nativeLimits: { availableAgentSeconds: 10, maxConcurrentRunners: 2 }, runnerPressure: { activeRunners: 0, maxConcurrentRunners: 2 },
            constraints: { availableAgentSeconds: 10, activeRunners: 0, maxConcurrentRunners: 2 },
        });
		const claimAt = new Date(Date.now() + 1_000).toISOString();
        const allocationService = new CapacityAllocationService(store);
        await allocationService.create('team-a', { id: 'allocation-a', reservePolicy: { percent: 0, overflow: 'deny' }, slices: [{ id: 'project:project-a', scope: 'project', targetId: 'project-a', policy: { minPercent: 0, targetPercent: 100, maxPercent: 100, hardCapPercent: 100 } }], borrowingRules: [] }, null, 'demand-allocation-create');
        await allocationService.activate('team-a', 'allocation-a', 'demand-allocation-activate');
        const grantService = new CapacityGrantService(store);
        await grantService.create('team-a', { id: 'grant-a', membershipId: 'membership-a', projectId: 'project-a', environment: 'local', executionProviderIds: ['codex'], capabilities: ['engineering'], allowedModes: ['planning'], dailyAgentSecondsLimit: 10, monthlyAgentSecondsLimit: 20, maxConcurrentAssignments: 2 }, 'demand-grant-create');
        await grantService.transition('team-a', 'grant-a', 'active', 'demand-grant-activate');
        await store.run(`UPDATE workday_capacity_envelopes SET allocation_set_id = 'allocation-a', envelope_json = '{"availableSeconds":10}', metadata_json = '{"grantId":"grant-a"}' WHERE id = 'workday-a'`);
        await new CapacityWorkdayDemandRepository(store).create({
            id: 'demand-race', teamId: 'team-a', projectId: 'project-a', workdayRunId: 'run-a', workdayId: 'workday-a',
            sourceType: 'idle-intent', sourceId: 'architect', mode: 'planning', projectAgentClassId: 'class-a', agentId: 'architect',
            handlerId: 'writer', activityType: 'reporting', priority: 1, requestedSeconds: 1, idempotencyKey: 'demand-race',
            payload: { repositoryId: 'treeseed-project-a', contentRoot: 'src/content', decisionInput: { input: { exactBaseRef: '0123456789abcdef0123456789abcdef01234567' } }, intent: { objective: 'Produce one plan.' } },
            metadata: { environment: 'local' }, availableAt: claimAt, now: claimAt,
        });
        let workspaceCreates = 0;
        let workspaceBaseRef = '';
        (controlPlane as unknown as {
            createCapacityWorkdayTreeDxWorkspace: (...args: unknown[]) => Promise<Record<string, unknown>>;
        }).createCapacityWorkdayTreeDxWorkspace = async (...args: unknown[]) => {
            workspaceCreates += 1;
            workspaceBaseRef = String((args[2] as Record<string, unknown>).baseRef ?? '');
            return {
                workspaceId: 'workspace-race',
                baseCommitSha: '0123456789abcdef0123456789abcdef01234567',
                baseRef: workspaceBaseRef,
                branchName: 'refs/heads/assignment-race',
            };
        };
        const results = await Promise.all([
            assignNextCompiledDemand(controlPlane, principal, session.id, [{ id: 'codex', status: 'available', capabilities: ['engineering'], maxConcurrentRunners: 1,
				lanes: [{ id: 'codex-operation', purpose: 'operation', maxConcurrentRunners: 1, capabilities: ['engineering'] }] }], claimAt),
            assignNextCompiledDemand(controlPlane, principal, session.id, [{ id: 'codex', status: 'available', capabilities: ['engineering'], maxConcurrentRunners: 1,
				lanes: [{ id: 'codex-operation', purpose: 'operation', maxConcurrentRunners: 1, capabilities: ['engineering'] }] }], claimAt),
        ]);
		expect(results.filter(Boolean)).toHaveLength(1);
        expect(results.find(Boolean)?.decisionInput).toMatchObject({ input: { activityType: 'reporting' }, metadata: { activityType: 'reporting' } });
        expect(results.find(Boolean)?.metadata).toMatchObject({ contentRoot: 'src/content' });
        expect(results.find(Boolean)?.executionProviderId).toBe('codex');
        expect(workspaceCreates).toBe(1);
        expect(workspaceBaseRef).toBe('refs/heads/main');
        expect(await store.all(`SELECT id FROM capacity_provider_assignments`)).toHaveLength(1);
        expect(await store.all(`SELECT id FROM capacity_reservations`)).toHaveLength(1);
        expect(await store.first(`SELECT status, allowed_operations_json FROM treedx_proxy_handles`)).toEqual({
            status: 'issued',
            allowed_operations_json: JSON.stringify(['files:read', 'files:search', 'files:write', 'git:commit', 'workspace:write']),
        });
    }
    finally {
        await database.close();
    }
});
});
