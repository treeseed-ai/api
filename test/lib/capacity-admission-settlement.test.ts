import { describe, expect, it } from 'vitest';
import { evaluateCapacityAdmission } from '@treeseed/sdk/agent-capacity/allocation';
import { decodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { commitCapacityAdmission } from '../../src/api/capacity/services/admission-service.ts';
import { settleCapacityReservationExactlyOnce } from '../../src/api/capacity/services/settlement-service.ts';
import { reportCapacityUsage } from '../../src/api/capacity/services/usage-report-service.ts';
import { CapacityOverrunService } from '../../src/api/capacity/services/overrun-service.ts';
import { aggregateCapacityCreditReservations } from '../../src/api/capacity/services/credit-reservation-aggregation-service.ts';
import { CapacityGovernanceRepository } from '../../src/api/capacity/repositories/governance.ts';
import { CapacityRegistrationService } from '../../src/api/capacity/services/registration-service.ts';
import { CapacitySecretCodec } from '../../src/api/capacity/security.ts';
import { loadCapacityAdmissionState } from '../../src/api/capacity/services/admission-state-service.ts';
import { CapacityAllocationService } from '../../src/api/capacity/services/allocation-service.ts';
import {
	capacityAdmissionInput as admission,
	createCapacityAdmissionTestHarness as harness,
	seedCapacityAdmissionDependencies as seedAdmissionDependencies,
} from './capacity-admission-test-fixture.ts';

describe('atomic capacity admission and settlement', () => {
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
		} finally { await database.close(); }
	});

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
				if (decision === 'approved' && counter.scope !== 'grant-concurrency') expect(Number(counter.hard_limit)).toBeGreaterThanOrEqual(consumedCredits);
			}
		} finally { await database.close(); }
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
				nativeUsage: { executionUsage: [{ kind: 'codex_subscription', unit: 'wall_minute', amount: 1.25 }] },
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
			const settled = await settleCapacityReservationExactlyOnce(store, { settlementKey: 'settle-a', teamId: 'team-a', membershipId: 'membership-a', reservationId: 'reservation-a', assignmentId: 'assignment-a', actualCredits: 4, providerUnits: 1.25, source: 'test', usageActual });
			expect(settled).toMatchObject({ replayed: false, entry: { settlement_key: 'settle-a' }, usageActualId: 'usage:assignment-a:0:aggregate' });
			const settledReplay = await settleCapacityReservationExactlyOnce(store, { settlementKey: 'settle-a', teamId: 'team-a', membershipId: 'membership-a', reservationId: 'reservation-a', assignmentId: 'assignment-a', actualCredits: 4, providerUnits: 1.25, source: 'test', usageActual });
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
		} finally {
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
		} finally {
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
		} finally {
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
			await store.run(`INSERT INTO capacity_provider_availability_sessions (id, membership_id, team_id, capacity_provider_id, environment, status, sequence, opened_at, refreshed_at, expires_at, available_from, available_until, execution_providers_json, capabilities_json, native_limits_json, runner_pressure_json, constraints_json, metadata_json, created_at, updated_at) VALUES ('session-a', 'membership-a', 'team-a', 'provider-a', 'local', 'open', 1, ?, ?, ?, ?, ?, '[{"id":"codex","kind":"codex"}]', '["engineering"]', '{"availableCredits":10,"maxConcurrentRunners":1}', '{"activeRunners":0,"maxConcurrentRunners":1}', '{"availableCredits":10,"maxConcurrentRunners":1,"activeRunners":0}', '{}', ?, ?)`, [now, now, new Date(Date.now() + 60_000).toISOString(), now, new Date(Date.now() + 60_000).toISOString(), now, now]);

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
			expect(await store.completeProviderAssignment(principal, 'lease-assignment-a', { leaseToken: leased.leaseToken, runnerId: 'runner-a' })).toBeNull();
			await settleCapacityReservationExactlyOnce(store, { settlementKey: 'lease-settle-a', teamId: 'team-a', membershipId: 'membership-a', reservationId: 'lease-reservation-a', assignmentId: 'lease-assignment-a', actualCredits: 4, source: 'test' });
			expect(await store.completeProviderAssignment(principal, 'lease-assignment-a', { leaseToken: leased.leaseToken, runnerId: 'runner-a' })).toMatchObject({ assignment: { status: 'completed', stateVersion: 3 } });
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
		} finally {
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
			await store.run(`INSERT INTO capacity_provider_availability_sessions (id, membership_id, team_id, capacity_provider_id, environment, status, sequence, opened_at, refreshed_at, expires_at, available_from, available_until, execution_providers_json, capabilities_json, native_limits_json, runner_pressure_json, constraints_json, metadata_json, created_at, updated_at) VALUES ('session-policy', 'membership-a', 'team-a', 'provider-a', 'local', 'open', 1, ?, ?, ?, ?, ?, '[{"id":"codex"}]', '["engineering"]', '{"availableCredits":10,"maxConcurrentRunners":1}', '{"activeRunners":0,"maxConcurrentRunners":1}', '{"availableCredits":10,"activeRunners":0,"maxConcurrentRunners":1}', '{}', ?, ?)`, [now, now, new Date(Date.now() + 60_000).toISOString(), now, new Date(Date.now() + 60_000).toISOString(), now, now]);
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
		} finally {
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
			await store.run(`INSERT INTO capacity_provider_availability_sessions (id, membership_id, team_id, capacity_provider_id, environment, status, sequence, opened_at, refreshed_at, expires_at, available_from, available_until, execution_providers_json, capabilities_json, native_limits_json, runner_pressure_json, constraints_json, metadata_json, created_at, updated_at) VALUES ('session-borrow', 'membership-a', 'team-a', 'provider-a', 'local', 'open', 1, ?, ?, ?, ?, ?, '[{"id":"codex"}]', '["engineering"]', '{"availableCredits":100,"maxConcurrentRunners":2}', '{"activeRunners":0,"maxConcurrentRunners":2}', '{"availableCredits":100,"activeRunners":0,"maxConcurrentRunners":2}', '{}', ?, ?)`, [now, now, new Date(Date.now() + 60_000).toISOString(), now, new Date(Date.now() + 60_000).toISOString(), now, now]);
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
		} finally {
			await database.close();
		}
	});
});
