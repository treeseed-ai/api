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

it('rejects an underreported terminal aggregate and permits a corrected idempotent retry', async () => {
    const { database, store } = harness();
    try {
        await store.ensureInitialized();
        const now = new Date().toISOString();
        await seedAdmissionDependencies(store, now);
        await store.run(`INSERT INTO workday_capacity_envelopes (id, team_id, project_id, allocation_set_id, status, started_at, envelope_json, metadata_json, created_at, updated_at) VALUES ('workday-usage', 'team-a', 'project-a', 'allocation-a', 'active', ?, '{"availableCredits":10}', '{}', ?, ?)`, [now, now, now]);
        await commitCapacityAdmission(store, { idempotencyKey: 'usage-admit', admission: admission(6), reservationId: 'usage-reservation', assignmentId: 'usage-assignment', assignment: { projectAgentClassId: 'class-a', workDayId: 'workday-usage' } });
        await reportCapacityUsage(store, { teamId: 'team-a', membershipId: 'membership-a', reservationId: 'usage-reservation', assignmentId: 'usage-assignment', idempotencyKey: 'usage-incremental', usageDimension: 'provider-billing', accountingMode: 'incremental', actualCredits: 5, source: 'test' });
        await expect(settleCapacityReservationExactlyOnce(store, { settlementKey: 'usage-settle-low', teamId: 'team-a', membershipId: 'membership-a', reservationId: 'usage-reservation', assignmentId: 'usage-assignment', actualCredits: 4, source: 'test' }))
            .rejects.toMatchObject({ code: 'capacity_usage_aggregate_underreported' });
        expect(await store.first(`SELECT settlement_token FROM capacity_reservations WHERE id = 'usage-reservation'`)).toEqual({ settlement_token: null });
        expect(await store.first(`SELECT COUNT(*) AS count FROM capacity_ledger_entries WHERE reservation_id = 'usage-reservation'`)).toEqual({ count: 0 });
        expect(await store.first(`SELECT COUNT(*) AS count FROM capacity_usage_actuals WHERE assignment_id = 'usage-assignment' AND accounting_mode = 'aggregate'`)).toEqual({ count: 0 });
        const corrected = await settleCapacityReservationExactlyOnce(store, { settlementKey: 'usage-settle-corrected', teamId: 'team-a', membershipId: 'membership-a', reservationId: 'usage-reservation', assignmentId: 'usage-assignment', actualCredits: 5, source: 'test' });
        expect(corrected).toMatchObject({ replayed: false, entry: { credits: 5 } });
    }
    finally {
        await database.close();
    }
});

it('commits reservation and assignment together, enforces counters, and settles exactly once', async () => {
    const { database, store } = harness();
    try {
        await store.ensureInitialized();
        const now = new Date().toISOString();
        await seedAdmissionDependencies(store, now);
        await store.run(`INSERT INTO workday_capacity_envelopes (id, team_id, project_id, allocation_set_id, status, started_at, envelope_json, metadata_json, created_at, updated_at) VALUES ('workday-a', 'team-a', 'project-a', 'allocation-a', 'active', ?, '{"availableCredits":10,"reservedCredits":0,"consumedCredits":0}', '{}', ?, ?)`, [now, now, now]);
        const first = await commitCapacityAdmission(store, {
            idempotencyKey: 'admit-a',
            admission: admission(6),
            assignment: {
                projectAgentClassId: 'class-a',
                workDayId: 'workday-a',
                synthesizedFrom: 'planning_input_request',
                synthesisKey: 'planning:request-a:provider-a',
                decisionId: 'decision-a',
                workspaceContext: { workspaceAccessMode: 'workspace_write' },
                metadata: { allowPlanningContentArtifacts: true },
                treedxProxyHandle: {
                    id: 'treedx-a',
                    projectId: 'project-a',
                    repositoryId: 'repository-a',
                    workspaceId: 'workspace-a',
                    scopes: ['project:read', 'project:write'],
                    allowedOperations: ['files:read', 'files:write'],
                    allowedPaths: ['docs/src/content/**'],
                    allowedReadPaths: ['**'],
                    allowedWritePaths: ['docs/src/content/**'],
                },
            },
            reservationId: 'reservation-a',
            assignmentId: 'assignment-a',
        });
        expect(first).toMatchObject({ replayed: false, reservation: { id: 'reservation-a', laneId: 'lane-a' }, assignment: { id: 'assignment-a', laneId: 'lane-a' } });
        expect(await store.first(`SELECT synthesized_from, synthesis_key, decision_id, treedx_proxy_handle_json FROM capacity_provider_assignments WHERE id = ?`, ['assignment-a'])).toEqual({
            synthesized_from: 'planning_input_request',
            synthesis_key: 'planning:request-a:provider-a',
            decision_id: 'decision-a',
            treedx_proxy_handle_json: JSON.stringify({
                id: 'treedx-a',
                projectId: 'project-a',
                repositoryId: 'repository-a',
                workspaceId: 'workspace-a',
                scopes: ['project:read', 'project:write'],
                allowedOperations: ['files:read', 'files:write'],
                allowedPaths: ['docs/src/content/**'],
                allowedReadPaths: ['**'],
                allowedWritePaths: ['docs/src/content/**'],
            }),
        });
        expect(await store.getTreeDxProxyHandle('team-a', 'project-a', 'treedx-a')).toMatchObject({
            id: 'treedx-a',
            teamId: 'team-a',
            projectId: 'project-a',
            assignmentId: 'assignment-a',
            repositoryId: 'repository-a',
            workspaceId: 'workspace-a',
            allowedReadPaths: ['**'],
            allowedWritePaths: ['docs/src/content/**'],
        });
        const replay = await commitCapacityAdmission(store, { idempotencyKey: 'admit-a', admission: admission(6), assignment: { projectAgentClassId: 'class-a', workDayId: 'workday-a' }, reservationId: 'other-reservation', assignmentId: 'other-assignment' });
        expect(replay).toMatchObject({ replayed: true, reservation: { id: 'reservation-a' }, assignment: { id: 'assignment-a' } });
        // pg-mem does not roll back rows written before a PostgreSQL CHECK violation, so isolate this
        // negative-path artifact from the workday projection; real PostgreSQL transaction rollback is
        // covered by the local service guarantee.
        await expect(commitCapacityAdmission(store, { idempotencyKey: 'admit-over-cap', admission: admission(5), assignment: { projectAgentClassId: 'class-a', workDayId: 'workday-over-cap' } })).rejects.toMatchObject({ code: 'capacity_admission_concurrent_limit_exhausted' });
        const usageActual = {
            nativeUsage: { executionUsage: [{ kind: 'codex', unit: 'wall_minute', amount: 1.25 }] },
            taskSignature: 'class-a:planning',
            executionProviderId: 'codex',
            inputTokens: 100,
            outputTokens: 25,
            wallMinutes: 1.25,
        };
        const tokens = await reportCapacityUsage(store, { teamId: 'team-a', membershipId: 'membership-a', reservationId: 'reservation-a', assignmentId: 'assignment-a', idempotencyKey: 'usage-tokens-a', usageDimension: 'tokens', actualCredits: 0, providerUnits: 125, source: 'test', usageActual: { nativeUsage: { inputTokens: 100, outputTokens: 25 } } });
        const tokensReplay = await reportCapacityUsage(store, { teamId: 'team-a', membershipId: 'membership-a', reservationId: 'reservation-a', assignmentId: 'assignment-a', idempotencyKey: 'usage-tokens-a', usageDimension: 'tokens', actualCredits: 0, providerUnits: 125, source: 'test', usageActual: { nativeUsage: { inputTokens: 100, outputTokens: 25 } } });
        expect(tokens.replayed).toBe(false);
        expect(tokensReplay.replayed).toBe(true);
        await reportCapacityUsage(store, { teamId: 'team-a', membershipId: 'membership-a', reservationId: 'reservation-a', assignmentId: 'assignment-a', idempotencyKey: 'usage-wall-a', usageDimension: 'wall-time', accountingMode: 'incremental', actualCredits: 2, providerUnits: 1.25, source: 'test', usageActual: { wallMinutes: 1.25 } });
        await expect(reportCapacityUsage(store, { teamId: 'team-a', membershipId: 'membership-a', reservationId: 'reservation-a', assignmentId: 'assignment-a', idempotencyKey: 'usage-tokens-conflict', usageDimension: 'tokens', accountingMode: 'incremental', actualCredits: 1, source: 'test' }))
            .rejects.toMatchObject({ code: 'capacity_usage_idempotency_conflict' });
        const fractionalProviderUnits = 2.4753833333333333;
        const settled = await settleCapacityReservationExactlyOnce(store, { settlementKey: 'settle-a', teamId: 'team-a', membershipId: 'membership-a', reservationId: 'reservation-a', assignmentId: 'assignment-a', actualCredits: 4, providerUnits: fractionalProviderUnits, source: 'test', usageActual });
        expect(settled).toMatchObject({ replayed: false, entry: { settlement_key: 'settle-a' }, usageActualId: 'usage:assignment-a:0:aggregate' });
        const settledReplay = await settleCapacityReservationExactlyOnce(store, { settlementKey: 'settle-a', teamId: 'team-a', membershipId: 'membership-a', reservationId: 'reservation-a', assignmentId: 'assignment-a', actualCredits: 4, providerUnits: fractionalProviderUnits, source: 'test', usageActual });
        expect(settledReplay.replayed).toBe(true);
        const terminalizationReplay = await settleCapacityReservationExactlyOnce(store, {
            settlementKey: 'workday-terminal:run-a:assignment-a', teamId: 'team-a', membershipId: 'membership-a',
            reservationId: 'reservation-a', assignmentId: 'assignment-a', actualCredits: 0,
            source: 'capacity_workday_terminalization', existingSettlementPolicy: 'replay',
        });
        expect(terminalizationReplay).toMatchObject({ replayed: true, entry: { settlement_key: 'settle-a', credits: 4 } });
        await expect(settleCapacityReservationExactlyOnce(store, { settlementKey: 'settle-wrong-attempt', teamId: 'team-a', membershipId: 'membership-a', reservationId: 'reservation-a', assignmentId: 'assignment-a', assignmentAttempt: 1, actualCredits: 4, source: 'test' }))
            .rejects.toMatchObject({ code: 'capacity_usage_assignment_attempt_conflict' });
        await expect(settleCapacityReservationExactlyOnce(store, { settlementKey: 'settle-bad-dimension', teamId: 'team-a', membershipId: 'membership-a', reservationId: 'reservation-a', assignmentId: 'assignment-a', usageDimension: 'Bad Dimension', actualCredits: 4, source: 'test' }))
            .rejects.toMatchObject({ code: 'capacity_usage_dimension_invalid' });
        expect(await store.all(`SELECT usage_dimension, actual_credits FROM capacity_usage_actuals WHERE assignment_id = ? ORDER BY usage_dimension`, ['assignment-a'])).toEqual([
            { usage_dimension: 'aggregate', actual_credits: 4 },
            { usage_dimension: 'tokens', actual_credits: 0 },
            { usage_dimension: 'wall-time', actual_credits: 2 },
        ]);
        await expect(reportCapacityUsage(store, { teamId: 'team-a', membershipId: 'membership-a', reservationId: 'reservation-a', assignmentId: 'assignment-a', idempotencyKey: 'usage-late', usageDimension: 'late', actualCredits: 0, source: 'test' }))
            .rejects.toMatchObject({ code: 'capacity_usage_reporting_closed' });
        expect(await store.first(`SELECT team_id, project_id, capacity_provider_id FROM capacity_provider_assignments WHERE id = ?`, ['assignment-a']))
            .toEqual({ team_id: 'team-a', project_id: 'project-a', capacity_provider_id: 'provider-a' });
        await store.createAgentModeRun({
            id: 'mode-run-a',
            teamId: 'team-a',
            providerAssignmentId: 'assignment-a',
            status: 'succeeded',
            usageActual: { nativeUsage: usageActual.nativeUsage },
        });
        await store.createAgentModeRun({
            id: 'mode-run-a',
            teamId: 'team-a',
            providerAssignmentId: 'assignment-a',
            status: 'succeeded',
            outputs: { status: 'replayed_telemetry' },
            usageActual: { nativeUsage: usageActual.nativeUsage },
        });
        expect(await store.first(`SELECT COUNT(*) AS count FROM agent_mode_runs WHERE id = 'mode-run-a'`)).toEqual({ count: 1 });
        expect(await store.getAgentModeRun('team-a', 'mode-run-a')).toMatchObject({
            id: 'mode-run-a',
            outputs: { status: 'replayed_telemetry' },
        });
        expect(await store.listAgentModeRunsPage('project-a', { assignmentId: 'assignment-a', limit: 1 })).toMatchObject({
            items: [{ id: 'mode-run-a', teamId: 'team-a', providerAssignmentId: 'assignment-a' }],
            page: { limit: 1, hasMore: false, nextCursor: null },
        });
        expect(await store.listExecutionRunsForTeamPage('team-a', { assignmentId: 'assignment-a', limit: 1 })).toMatchObject({
            items: [{
                    id: 'mode-run-a',
                    assignment: { id: 'assignment-a' },
                    modeRuns: [{ id: 'mode-run-a', assignmentId: 'assignment-a' }],
                }],
            page: { limit: 1, hasMore: false, nextCursor: null },
        });
        const summary = await store.getWorkdayCapacitySummary('workday-a');
        expect(summary).toMatchObject({
            payload: {
                totals: {
                    assignments: { total: 1, completed: 0 },
                    modeRuns: { total: 1, succeeded: 1, usageReported: 1 },
                    reservations: 1,
                    usageActuals: 3,
                    ledgerEntries: 1,
                },
                evidence: {
                    modeRuns: { items: [{ id: 'mode-run-a', status: 'succeeded' }], total: 1, page: { hasMore: false } },
                },
                settlement: {
                    reservedCredits: 6,
                    consumedCredits: 4,
                    releasedCredits: 2,
                    providerConfidence: 'high',
                    warnings: [],
                    nativeUsage: {
                        taskActualCount: 1,
                        modeRunUsageCount: 1,
                        inputTokens: 100,
                        outputTokens: 25,
                        wallMinutes: 1.25,
                    },
                },
            },
        });
        const counters = await store.all(`SELECT scope, committed_amount FROM capacity_admission_counters ORDER BY scope ASC`);
        expect(counters).toEqual([
            { scope: 'allocation-slice', committed_amount: 4 },
            { scope: 'grant-concurrency', committed_amount: 0 },
            { scope: 'grant-daily', committed_amount: 4 },
            { scope: 'grant-monthly', committed_amount: 4 },
            { scope: 'workday', committed_amount: 4 },
        ]);
        await expect(commitCapacityAdmission(store, { idempotencyKey: 'admit-b', admission: admission(6, 4), assignment: { projectAgentClassId: 'class-a', workDayId: 'workday-a' }, reservationId: 'reservation-b', assignmentId: 'assignment-b' })).resolves.toMatchObject({ replayed: false });
        await expect(store.createAgentModeRun({
            id: 'mode-run-a',
            teamId: 'team-a',
            providerAssignmentId: 'assignment-b',
            status: 'running',
        })).rejects.toMatchObject({ code: 'agent_mode_run_idempotency_conflict', status: 409 });
        expect(await store.getAgentModeRun('team-a', 'mode-run-a')).toMatchObject({
            providerAssignmentId: 'assignment-a',
            status: 'succeeded',
        });
        await store.createAgentModeRun({
            id: 'mode-run-b',
            teamId: 'team-a',
            providerAssignmentId: 'assignment-b',
            status: 'running',
        });
        const firstExecutionPage = await store.listExecutionRunsForTeamPage('team-a', { limit: 1 });
        expect(firstExecutionPage.page).toMatchObject({ limit: 1, hasMore: true, nextCursor: expect.any(String) });
        const secondExecutionPage = await store.listExecutionRunsForTeamPage('team-a', {
            limit: 1,
            cursor: decodeCapacityPageCursor(firstExecutionPage.page.nextCursor),
        });
        expect(new Set([
            firstExecutionPage.items[0]?.id,
            secondExecutionPage.items[0]?.id,
        ])).toEqual(new Set(['mode-run-a', 'mode-run-b']));
        expect(secondExecutionPage.page).toEqual({ limit: 1, hasMore: false, nextCursor: null });
    }
    finally {
        await database.close();
    }
});

it('serializes concurrent admission retries and reservation settlement exactly once', async () => {
    const { database, store } = harness();
    try {
        await store.ensureInitialized();
        await seedAdmissionDependencies(store, new Date().toISOString());
        const now = '2026-07-17T12:00:00.000Z';
        await store.run(`INSERT INTO workday_capacity_envelopes (id, team_id, project_id, allocation_set_id, status, started_at, envelope_json, metadata_json, created_at, updated_at) VALUES ('workday-a', 'team-a', 'project-a', 'allocation-a', 'active', ?, '{"availableCredits":10}', '{}', ?, ?)`, [now, now, now]);
        const request = (suffix: string) => commitCapacityAdmission(store, {
            idempotencyKey: 'concurrent-admission',
            admission: admission(6, 0, now),
            reservationId: `reservation-${suffix}`,
            assignmentId: `assignment-${suffix}`,
            assignment: { projectAgentClassId: 'class-a', workDayId: 'workday-a' },
        });
        const admitted = await Promise.all([request('one'), request('two')]);
        expect(admitted.filter((result) => result.replayed)).toHaveLength(1);
        expect(admitted.filter((result) => !result.replayed)).toHaveLength(1);
        const reservationId = String(admitted[0]!.reservation.id);
        const assignmentId = String(admitted[0]!.assignment.id);
        expect(await store.first(`SELECT COUNT(*) AS count FROM capacity_reservations WHERE idempotency_key = 'concurrent-admission'`)).toEqual({ count: 1 });
        expect(await store.first(`SELECT COUNT(*) AS count FROM capacity_provider_assignments WHERE reservation_id = ?`, [reservationId])).toEqual({ count: 1 });
        expect((await store.all(`SELECT scope, committed_amount FROM capacity_admission_counters ORDER BY scope`)).map((row) => [row.scope, Number(row.committed_amount)])).toEqual([
            ['allocation-slice', 6],
            ['grant-concurrency', 1],
            ['grant-daily', 6],
            ['grant-monthly', 6],
            ['workday', 6],
        ]);
        const settlement = (settlementKey: string) => settleCapacityReservationExactlyOnce(store, {
            settlementKey,
            teamId: 'team-a',
            membershipId: 'membership-a',
            reservationId,
            assignmentId,
            actualCredits: 4,
            providerUnits: 2,
            source: 'test',
        });
        const settled = await Promise.all([settlement('concurrent-settlement-one'), settlement('concurrent-settlement-two')]);
        expect(settled.filter((result) => result.replayed)).toHaveLength(1);
        expect(settled.filter((result) => !result.replayed)).toHaveLength(1);
        expect(await store.first(`SELECT COUNT(*) AS count FROM capacity_ledger_entries WHERE reservation_id = ? AND phase = 'task_completed_actual_settlement'`, [reservationId])).toEqual({ count: 1 });
        expect(await store.first(`SELECT COUNT(*) AS count FROM capacity_usage_actuals WHERE assignment_id = ?`, [assignmentId])).toEqual({ count: 1 });
        expect((await store.all(`SELECT scope, committed_amount FROM capacity_admission_counters ORDER BY scope`)).map((row) => [row.scope, Number(row.committed_amount)])).toEqual([
            ['allocation-slice', 4],
            ['grant-concurrency', 0],
            ['grant-daily', 4],
            ['grant-monthly', 4],
            ['workday', 4],
        ]);
        const capacityRace = await Promise.allSettled(['three', 'four'].map((suffix) => commitCapacityAdmission(store, {
            idempotencyKey: `hard-cap-${suffix}`,
            admission: admission(6, 4, now),
            reservationId: `reservation-${suffix}`,
            assignmentId: `assignment-${suffix}`,
            assignment: { projectAgentClassId: 'class-a', workDayId: 'workday-a' },
        })));
        expect(capacityRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(capacityRace.filter((result) => result.status === 'rejected')).toHaveLength(1);
        expect(capacityRace.find((result) => result.status === 'rejected')).toMatchObject({
            status: 'rejected',
            reason: { code: 'capacity_admission_concurrent_limit_exhausted' },
        });
        expect(await store.first(`SELECT COUNT(*) AS count FROM capacity_provider_assignments WHERE work_day_id = 'workday-a'`)).toEqual({ count: 2 });
        expect(await store.first(`SELECT committed_amount FROM capacity_admission_counters WHERE scope = 'grant-daily'`)).toEqual({ committed_amount: 10 });
        await expect(settleCapacityReservationExactlyOnce(store, {
            settlementKey: 'conflicting-settlement', teamId: 'team-a', membershipId: 'membership-a',
            reservationId, assignmentId, actualCredits: 5, providerUnits: 2, source: 'test',
        })).rejects.toMatchObject({ code: 'capacity_settlement_usage_conflict' });
    }
    finally {
        await database.close();
    }
});
});
