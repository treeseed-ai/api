import { describe, expect, it } from 'vitest';
import { evaluateCapacityAdmission } from '@treeseed/sdk/agent-capacity/allocation';
import { decodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { commitCapacityAdmission } from '../../../../../src/api/capacity/services/support/admission-service.ts';
import { settleCapacityReservationExactlyOnce } from '../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts';
import { reportCapacityUsage } from '../../../../../src/api/capacity/services/capacity/accounting/usage-report-service.ts';
import { CapacityOverrunService } from '../../../../../src/api/capacity/services/capacity/accounting/overrun-service.ts';
import { aggregateCapacityCreditReservations } from '../../../../../src/api/capacity/services/capacity/accounting/credit-reservation-aggregation-service.ts';
import { CapacityGovernanceRepository } from '../../../../../src/api/capacity/repositories/governance/policy/governance.ts';
import { CapacityRegistrationService } from '../../../../../src/api/capacity/services/support/registration-service.ts';
import { CapacitySecretCodec } from '../../../../../src/api/capacity/security.ts';
import { loadCapacityAdmissionState } from '../../../../../src/api/capacity/services/support/admission-state-service.ts';
import { CapacityAllocationService } from '../../../../../src/api/capacity/services/capacity/allocations/allocation-service.ts';
import { capacityAdmissionInput as admission, createCapacityAdmissionTestHarness as harness, seedCapacityAdmissionDependencies as seedAdmissionDependencies, } from '../../../../support/capacity/admission.ts';

describe('atomic capacity admission and settlement', () => {
it.each([
    ['approved', 12],
    ['rejected', 0],
] as const)('holds an overrun and applies an explicit %s team decision exactly once', async (decision, consumedCredits) => {
    const { database, store } = harness();
    try {
        await store.ensureInitialized();
        const now = new Date().toISOString();
        await seedAdmissionDependencies(store, now);
        await store.run(`INSERT INTO workday_capacity_envelopes (id, team_id, project_id, allocation_set_id, status, started_at, envelope_json, metadata_json, created_at, updated_at) VALUES ('workday-overrun', 'team-a', 'project-a', 'allocation-a', 'active', ?, '{"availableCredits":10}', '{}', ?, ?)`, [now, now, now]);
        await commitCapacityAdmission(store, { idempotencyKey: `overrun-admit-${decision}`, admission: admission(6, 0, now), reservationId: `overrun-reservation-${decision}`, assignmentId: `overrun-assignment-${decision}`, assignment: { projectAgentClassId: 'class-a', workDayId: 'workday-overrun' } });
        await expect(settleCapacityReservationExactlyOnce(store, { settlementKey: `overrun-report-${decision}`, teamId: 'team-a', membershipId: 'membership-a', reservationId: `overrun-reservation-${decision}`, assignmentId: `overrun-assignment-${decision}`, actualCredits: 12, source: 'test' }))
            .rejects.toMatchObject({ code: 'capacity_settlement_overrun_requires_approval' });
        expect(await store.first(`SELECT state FROM capacity_reservations WHERE id = ?`, [`overrun-reservation-${decision}`])).toEqual({ state: 'overran_pending_approval' });
        const service = new CapacityOverrunService(store);
        const first = await service.decide('team-a', `overrun-reservation-${decision}`, decision, 'owner-a', `decision-${decision}`);
        const replay = await service.decide('team-a', `overrun-reservation-${decision}`, decision, 'owner-a', `decision-${decision}`);
        expect(first).toMatchObject({ decision, settlement: { replayed: false } });
        expect(replay).toMatchObject({ decision, settlement: { replayed: true } });
        expect(await store.first(`SELECT state, consumed_credits FROM capacity_reservations WHERE id = ?`, [`overrun-reservation-${decision}`])).toEqual({ state: 'consumed', consumed_credits: consumedCredits });
        expect(await store.all(`SELECT phase, credits FROM capacity_ledger_entries WHERE reservation_id = ? ORDER BY phase`, [`overrun-reservation-${decision}`])).toEqual([
            { phase: 'overrun_hold', credits: 12 },
            { phase: 'task_completed_actual_settlement', credits: consumedCredits },
        ]);
        expect(await store.first(`SELECT COUNT(*) AS count FROM capacity_audit_events WHERE resource_id = ? AND action = ?`, [`overrun-reservation-${decision}`, `capacity-overrun.${decision}`])).toEqual({ count: 1 });
        const counters = await store.all(`SELECT scope, hard_limit, committed_amount FROM capacity_admission_counters ORDER BY scope`);
        for (const counter of counters) {
            const expected = counter.scope === 'grant-concurrency' ? 0 : consumedCredits;
            expect(Number(counter.committed_amount)).toBe(expected);
            if (decision === 'approved' && counter.scope !== 'grant-concurrency')
                expect(Number(counter.hard_limit)).toBeGreaterThanOrEqual(consumedCredits);
        }
    }
    finally {
        await database.close();
    }
});

it('opens a fresh daily counter while preserving monthly commitments across UTC rollover', async () => {
    const { database, store } = harness();
    try {
        await store.ensureInitialized();
        await seedAdmissionDependencies(store, '2026-07-17T23:59:59.000Z');
        const beforeMidnight = '2026-07-17T23:59:59.000Z';
        const afterMidnight = '2026-07-18T00:00:01.000Z';
        await store.run(`INSERT INTO workday_capacity_envelopes (id, team_id, project_id, allocation_set_id, status, started_at, envelope_json, metadata_json, created_at, updated_at) VALUES ('workday-a', 'team-a', 'project-a', 'allocation-a', 'active', ?, '{"availableCredits":10}', '{}', ?, ?)`, [beforeMidnight, beforeMidnight, beforeMidnight]);
        await commitCapacityAdmission(store, {
            idempotencyKey: 'before-rollover', admission: admission(6, 0, beforeMidnight),
            reservationId: 'reservation-before-rollover', assignmentId: 'assignment-before-rollover',
            assignment: { projectAgentClassId: 'class-a', workDayId: 'workday-a' },
        });
        await settleCapacityReservationExactlyOnce(store, {
            settlementKey: 'settle-before-rollover', teamId: 'team-a', membershipId: 'membership-a',
            reservationId: 'reservation-before-rollover', assignmentId: 'assignment-before-rollover', actualCredits: 4, source: 'test',
        });
        await store.run(`UPDATE capacity_reservations SET updated_at = ? WHERE id = 'reservation-before-rollover'`, [beforeMidnight]);
        const after = admission(6, 4, afterMidnight);
        after.grantCommitted.dailyCredits = 0;
        await commitCapacityAdmission(store, {
            idempotencyKey: 'after-rollover', admission: after,
            reservationId: 'reservation-after-rollover', assignmentId: 'assignment-after-rollover',
            assignment: { projectAgentClassId: 'class-a', workDayId: 'workday-a' },
        });
        const daily = await store.all(`SELECT period_key, committed_amount FROM capacity_admission_counters WHERE scope = 'grant-daily' ORDER BY period_key`);
        expect(daily.map((row) => ({ periodKey: row.period_key, committed: Number(row.committed_amount) }))).toEqual([
            { periodKey: '2026-07-17', committed: 4 },
            { periodKey: '2026-07-18', committed: 6 },
        ]);
        expect(await aggregateCapacityCreditReservations(store, { teamId: 'team-a', now: afterMidnight })).toMatchObject({
            activeReservedCredits: 6,
            dailyUsedCredits: 0,
            dailyCommittedCredits: 6,
            monthlyUsedCredits: 4,
            monthlyCommittedCredits: 10,
            dailyWindowStartAt: '2026-07-18T00:00:00.000Z',
            monthlyWindowStartAt: '2026-07-01T00:00:00.000Z',
        });
    }
    finally {
        await database.close();
    }
});

it('leases only admitted membership work with CAS and releases it when membership authority is suspended', async () => {
    const { database, store } = harness();
    try {
        await store.ensureInitialized();
        await store.createTeam({ id: 'team-a', slug: 'team-a', name: 'team-a' });
        const now = new Date().toISOString();
        await store.run(`INSERT INTO capacity_providers (id, fingerprint, public_jwk_json, display_name, identity_version, status, metadata_json, created_at, updated_at) VALUES (?, ?, '{}', ?, 1, 'active', '{}', ?, ?)`, ['provider-a', 'sha256:provider-a', 'Provider A', now, now]);
        await store.run(`INSERT INTO capacity_execution_providers (id, capacity_provider_id, display_name, adapter, status, capabilities_json, native_unit, quota_visibility, max_concurrent_runners, native_limits_json, metadata_json, created_at, updated_at) VALUES ('codex', 'provider-a', 'Codex', 'codex', 'active', '["engineering"]', 'wall_minute', 'exact', 1, '[]', '{}', ?, ?)`, [now, now]);
        await store.run(`INSERT INTO capacity_provider_lanes (id, capacity_provider_id, execution_provider_id, display_name, status, capabilities_json, max_concurrent_runners, native_limits_json, metadata_json, created_at, updated_at) VALUES ('lane-a', 'provider-a', 'codex', 'Lane A', 'active', '["engineering"]', 1, '[]', '{}', ?, ?)`, [now, now]);
        await store.run(`INSERT INTO capacity_provider_team_memberships (id, team_id, capacity_provider_id, status, approved_at, approved_by_id, metadata_json, created_at, updated_at) VALUES ('membership-a', 'team-a', 'provider-a', 'approved', ?, 'owner-a', '{}', ?, ?)`, [now, now, now]);
        await store.run(`INSERT INTO projects (id, team_id, slug, name, metadata_json, created_at, updated_at) VALUES ('project-a', 'team-a', 'project-a', 'Project A', '{}', ?, ?)`, [now, now]);
        await store.run(`INSERT INTO project_agent_classes (id, team_id, project_id, slug, name, status, allowed_modes_json, required_capabilities_json, kernel_profile_json, kernel_policy_json, handler_refs_json, output_contracts_json, metadata_json, created_at, updated_at) VALUES ('class-a', 'team-a', 'project-a', 'engineer', 'Engineer', 'active', '["planning"]', '["engineering"]', '{}', '{}', '{}', '{}', '{}', ?, ?)`, [now, now]);
        await store.run(`INSERT INTO capacity_allocation_sets (id, team_id, version, status, effective_from, reserve_policy_json, slices_json, borrowing_rules_json, metadata_json, created_at, updated_at) VALUES ('allocation-a', 'team-a', 1, 'active', ?, '{"percent":0,"overflow":"deny"}', '[{"id":"project:project-a","scope":"project","targetId":"project-a","policy":{"minPercent":0,"targetPercent":100,"maxPercent":100,"hardCapPercent":100}}]', '[]', '{}', ?, ?)`, [now, now, now]);
        await store.run(`INSERT INTO capacity_grants (id, membership_id, capacity_provider_id, team_id, project_id, environment, status, execution_provider_ids_json, lane_ids_json, capabilities_json, allowed_modes_json, daily_credit_limit, monthly_credit_limit, max_concurrent_assignments, unmetered, metadata_json, created_at, updated_at) VALUES ('grant-a', 'membership-a', 'provider-a', 'team-a', 'project-a', 'local', 'active', '["codex"]', '["lane-a"]', '["engineering"]', '["planning"]', 10, 20, 1, 0, '{}', ?, ?)`, [now, now]);
        await store.run(`INSERT INTO workday_capacity_envelopes (id, team_id, project_id, allocation_set_id, status, started_at, envelope_json, metadata_json, created_at, updated_at) VALUES ('workday-a', 'team-a', 'project-a', 'allocation-a', 'active', ?, '{"totalCredits":10}', '{"grantId":"grant-a"}', ?, ?)`, [now, now, now]);
        await store.run(`INSERT INTO capacity_provider_availability_sessions (id, membership_id, team_id, capacity_provider_id, environment, status, sequence, opened_at, refreshed_at, expires_at, available_from, available_until, execution_providers_json, capabilities_json, native_limits_json, runner_pressure_json, constraints_json, metadata_json, created_at, updated_at) VALUES ('session-a', 'membership-a', 'team-a', 'provider-a', 'local', 'open', 1, ?, ?, ?, ?, ?, '[{"id":"codex","kind":"codex"}]', '["engineering"]', '{"availableCredits":10,"maxConcurrentRunners":1}', '{"activeRunners":0,"maxConcurrentRunners":1}', '{"availableCredits":10,"maxConcurrentRunners":1,"activeRunners":0}', '{}', ?, ?)`, [now, now, new Date(Date.now() + 60000).toISOString(), now, new Date(Date.now() + 60000).toISOString(), now, now]);
        await commitCapacityAdmission(store, { idempotencyKey: 'lease-admit-a', admission: admission(6), assignment: { projectAgentClassId: 'class-a', workDayId: 'workday-a', providerSessionId: 'session-a' }, reservationId: 'lease-reservation-a', assignmentId: 'lease-assignment-a' });
        const principal = { membershipId: 'membership-a', teamId: 'team-a', capacityProviderId: 'provider-a' };
        await expect(store.leaseNextProviderAssignment(principal, { sessionId: 'session-a', leaseSeconds: Number.NaN }))
            .rejects.toMatchObject({ code: 'provider_assignment_lease_seconds_invalid', status: 400 });
        expect(await store.getProviderAssignment('team-a', 'lease-assignment-a')).toMatchObject({ status: 'pending', stateVersion: 1 });
        const leased = await store.leaseNextProviderAssignment(principal, { sessionId: 'session-a', runnerId: 'runner-a' });
        expect(leased).toMatchObject({
            assignment: {
                id: 'lease-assignment-a', membershipId: 'membership-a', stateVersion: 2, status: 'leased',
                explanation: { eligible: true, gates: { leaseState: 'leased', runnerId: 'runner-a' } },
            },
        });
        const concurrentRenewals = await Promise.all(Array.from({ length: 4 }, () => store.renewProviderAssignmentLease(principal, 'lease-assignment-a', {
            leaseToken: leased.leaseToken,
            runnerId: 'runner-a',
        })));
        expect(concurrentRenewals.every((renewal) => renewal?.assignment.status === 'leased')).toBe(true);
        expect(await store.completeProviderAssignment(principal, 'lease-assignment-a', { leaseToken: leased.leaseToken, runnerId: 'runner-a' })).toBeNull();
        await settleCapacityReservationExactlyOnce(store, { settlementKey: 'lease-settle-a', teamId: 'team-a', membershipId: 'membership-a', reservationId: 'lease-reservation-a', assignmentId: 'lease-assignment-a', actualCredits: 4, source: 'test' });
        expect(await store.completeProviderAssignment(principal, 'lease-assignment-a', { leaseToken: leased.leaseToken, runnerId: 'runner-a' })).toMatchObject({ assignment: { status: 'completed', stateVersion: expect.any(Number) } });
        await commitCapacityAdmission(store, { idempotencyKey: 'lease-admit-b', admission: admission(6, 4), assignment: { projectAgentClassId: 'class-a', workDayId: 'workday-a', providerSessionId: 'session-a' }, reservationId: 'lease-reservation-b', assignmentId: 'lease-assignment-b' });
        const secondLease = await store.leaseNextProviderAssignment(principal, { sessionId: 'session-a', runnerId: 'runner-b' });
        expect(secondLease).toMatchObject({ assignment: { id: 'lease-assignment-b', status: 'leased', stateVersion: 2 } });
        const registration = new CapacityRegistrationService(new CapacityGovernanceRepository(store), new CapacitySecretCodec('capacity-membership-suspension-test-secret'), 'https://api.example.test');
        await registration.updateMembership('team-a', 'membership-a', 'owner-a', 'suspended', 'suspend-membership-a');
        expect(await store.getProviderAssignment('team-a', 'lease-assignment-b')).toMatchObject({ status: 'failed', leaseState: 'released', stateVersion: 3, lifecycleCode: 'provider_membership_suspended' });
        const counters = await store.all(`SELECT scope, committed_amount FROM capacity_admission_counters`);
        expect(counters.filter((row) => row.scope === 'grant-concurrency').every((row) => Number(row.committed_amount) === 0)).toBe(true);
        expect(counters.filter((row) => row.scope !== 'grant-concurrency').every((row) => Number(row.committed_amount) === 4)).toBe(true);
        expect(await store.renewProviderAssignmentLease(principal, 'lease-assignment-b', { leaseToken: secondLease.leaseToken, runnerId: 'runner-b' })).toBeNull();
    }
    finally {
        await database.close();
    }
});

it('changes real admission when a replacement stored allocation policy is activated', async () => {
    const { database, store } = harness();
    try {
        await store.ensureInitialized();
        const now = new Date().toISOString();
        await seedAdmissionDependencies(store, now);
        await store.run(`UPDATE capacity_allocation_sets SET reserve_policy_json = '{"percent":50,"overflow":"deny"}', slices_json = '[{"id":"project:project-a","scope":"project","targetId":"project-a","policy":{"minPercent":0,"targetPercent":50,"maxPercent":50,"hardCapPercent":50}}]' WHERE id = 'allocation-a'`);
        await store.run(`INSERT INTO workday_capacity_envelopes (id, team_id, project_id, allocation_set_id, status, started_at, envelope_json, metadata_json, created_at, updated_at) VALUES ('workday-policy', 'team-a', 'project-a', 'allocation-a', 'active', ?, '{"totalCredits":10}', '{"grantId":"grant-a"}', ?, ?)`, [now, now, now]);
        await store.run(`INSERT INTO capacity_provider_availability_sessions (id, membership_id, team_id, capacity_provider_id, environment, status, sequence, opened_at, refreshed_at, expires_at, available_from, available_until, execution_providers_json, capabilities_json, native_limits_json, runner_pressure_json, constraints_json, metadata_json, created_at, updated_at) VALUES ('session-policy', 'membership-a', 'team-a', 'provider-a', 'local', 'open', 1, ?, ?, ?, ?, ?, '[{"id":"codex"}]', '["engineering"]', '{"availableCredits":10,"maxConcurrentRunners":1}', '{"activeRunners":0,"maxConcurrentRunners":1}', '{"availableCredits":10,"activeRunners":0,"maxConcurrentRunners":1}', '{}', ?, ?)`, [now, now, new Date(Date.now() + 60000).toISOString(), now, new Date(Date.now() + 60000).toISOString(), now, now]);
        const request = { teamId: 'team-a', providerId: 'provider-a', membershipId: 'membership-a', projectId: 'project-a', environment: 'local', projectAgentClassId: 'class-a', mode: 'planning' as const, workDayId: 'workday-policy', requestedCredits: 6, executionProviderId: 'codex', laneId: 'lane-a', providerSessionId: 'session-policy', requiredCapabilities: ['engineering'] };
        const deniedState = await loadCapacityAdmissionState(store, request);
        expect(evaluateCapacityAdmission(deniedState)).toMatchObject({ allowed: false, reasonCodes: expect.arrayContaining(['allocation_borrowing_denied']) });
        const allocations = new CapacityAllocationService(store);
        const replacement = await allocations.create('team-a', {
            id: 'allocation-policy-replacement', effectiveFrom: now, reservePolicy: { percent: 0, overflow: 'deny' },
            slices: [{ id: 'project:project-a', scope: 'project', targetId: 'project-a', policy: { minPercent: 0, targetPercent: 100, maxPercent: 100, hardCapPercent: 100 } }], borrowingRules: [],
        }, null, 'policy-replacement-create');
        await allocations.activate('team-a', replacement.id, 'policy-replacement-activate');
        await store.run(`UPDATE workday_capacity_envelopes SET allocation_set_id = ?, updated_at = ? WHERE id = 'workday-policy'`, [replacement.id, now]);
        const allowedState = await loadCapacityAdmissionState(store, request);
        expect(evaluateCapacityAdmission(allowedState)).toMatchObject({ allowed: true, allocationSetId: replacement.id, maxReservableCredits: 10 });
        await expect(commitCapacityAdmission(store, { idempotencyKey: 'stored-policy-admit', admission: allowedState, reservationId: 'stored-policy-reservation', assignmentId: 'stored-policy-assignment', assignment: { projectAgentClassId: 'class-a', workDayId: 'workday-policy', providerSessionId: 'session-policy' } })).resolves.toMatchObject({ replayed: false, reservation: { id: 'stored-policy-reservation', allocationSetId: replacement.id } });
    }
    finally {
        await database.close();
    }
});

it('commits stored sibling borrowing with donor, recipient, overflow, and rule counters', async () => {
    const { database, store } = harness();
    try {
        await store.ensureInitialized();
        const now = new Date().toISOString();
        await seedAdmissionDependencies(store, now);
        await store.run(`INSERT INTO projects (id, team_id, slug, name, metadata_json, created_at, updated_at) VALUES ('project-b', 'team-a', 'project-b', 'Project B', '{}', ?, ?)`, [now, now]);
        await store.run(`UPDATE capacity_allocation_sets SET reserve_policy_json = '{"percent":0,"overflow":"borrow"}', slices_json = '[{"id":"project-a","scope":"project","targetId":"project-a","policy":{"minPercent":30,"targetPercent":50,"maxPercent":60,"hardCapPercent":70}},{"id":"project-b","scope":"project","targetId":"project-b","policy":{"minPercent":30,"targetPercent":50,"maxPercent":60,"hardCapPercent":70}}]', borrowing_rules_json = '[{"id":"project-b-to-a","fromSliceId":"project-b","toSliceId":"project-a","maxPercent":20,"requiresApproval":false}]' WHERE id = 'allocation-a'`);
        await store.run(`UPDATE capacity_grants SET daily_credit_limit = 100, monthly_credit_limit = 100, max_concurrent_assignments = 2 WHERE id = 'grant-a'`);
        await store.run(`INSERT INTO workday_capacity_envelopes (id, team_id, project_id, allocation_set_id, status, started_at, envelope_json, metadata_json, created_at, updated_at) VALUES ('workday-borrow', 'team-a', 'project-a', 'allocation-a', 'active', ?, '{"totalCredits":100}', '{"grantId":"grant-a"}', ?, ?)`, [now, now, now]);
        await store.run(`INSERT INTO capacity_provider_availability_sessions (id, membership_id, team_id, capacity_provider_id, environment, status, sequence, opened_at, refreshed_at, expires_at, available_from, available_until, execution_providers_json, capabilities_json, native_limits_json, runner_pressure_json, constraints_json, metadata_json, created_at, updated_at) VALUES ('session-borrow', 'membership-a', 'team-a', 'provider-a', 'local', 'open', 1, ?, ?, ?, ?, ?, '[{"id":"codex"}]', '["engineering"]', '{"availableCredits":100,"maxConcurrentRunners":2}', '{"activeRunners":0,"maxConcurrentRunners":2}', '{"availableCredits":100,"activeRunners":0,"maxConcurrentRunners":2}', '{}', ?, ?)`, [now, now, new Date(Date.now() + 60000).toISOString(), now, new Date(Date.now() + 60000).toISOString(), now, now]);
        const seedCounter = (id: string, scope: string, scopeId: string, hardLimit: number, amount: number) => store.run(`INSERT INTO capacity_admission_counters (id, team_id, scope, scope_id, period_key, hard_limit, committed_amount, state_version, created_at, updated_at) VALUES (?, 'team-a', ?, ?, ?, ?, ?, 1, ?, ?)`, [id, scope, scopeId, id.includes('grant-daily') ? now.slice(0, 10) : id.includes('grant-monthly') ? now.slice(0, 7) : 'workday-borrow', hardLimit, amount, now, now]);
        await seedCounter('allocation-slice:allocation-a:project-a:workday-borrow', 'allocation-slice', 'allocation-a:project-a', 60, 55);
        await seedCounter('allocation-slice:allocation-a:project-b:workday-borrow', 'allocation-slice', 'allocation-a:project-b', 50, 30);
        await seedCounter('workday:workday-borrow:lifetime', 'workday', 'workday-borrow', 100, 55);
        await seedCounter(`grant-daily:grant-a:${now.slice(0, 10)}`, 'grant-daily', 'grant-a', 100, 55);
        await seedCounter(`grant-monthly:grant-a:${now.slice(0, 7)}`, 'grant-monthly', 'grant-a', 100, 55);
        const state = await loadCapacityAdmissionState(store, { teamId: 'team-a', providerId: 'provider-a', membershipId: 'membership-a', projectId: 'project-a', environment: 'local', projectAgentClassId: 'class-a', mode: 'planning', workDayId: 'workday-borrow', requestedCredits: 10, executionProviderId: 'codex', laneId: 'lane-a', providerSessionId: 'session-borrow', requiredCapabilities: ['engineering'] });
        const decision = evaluateCapacityAdmission(state);
        expect(decision).toMatchObject({ allowed: true, maxReservableCredits: 15 });
        expect(decision.counterClaims).toEqual(expect.arrayContaining([expect.objectContaining({ scope: 'allocation-overflow', amount: 5 }), expect.objectContaining({ scope: 'allocation-borrow', amount: 5 })]));
        await commitCapacityAdmission(store, { idempotencyKey: 'borrow-admit', admission: state, reservationId: 'borrow-reservation', assignmentId: 'borrow-assignment', assignment: { projectAgentClassId: 'class-a', workDayId: 'workday-borrow', providerSessionId: 'session-borrow' } });
        expect((await store.all(`SELECT scope, committed_amount FROM capacity_admission_counters WHERE scope IN ('allocation-overflow','allocation-borrow') ORDER BY scope`)).map((row) => [row.scope, Number(row.committed_amount)])).toEqual([['allocation-borrow', 5], ['allocation-overflow', 5]]);
        expect(Number((await store.first(`SELECT committed_amount FROM capacity_admission_counters WHERE id = 'allocation-slice:allocation-a:project-b:workday-borrow'`))?.committed_amount)).toBe(35);
    }
    finally {
        await database.close();
    }
});
});
