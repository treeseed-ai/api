import { describe, expect, it, vi } from 'vitest';
import { createAssignmentService } from '../../../../../../../src/api/control-plane/repositories/capacity/assignment-service.ts';
import { isAutomaticUnknownZero } from '../../../../../../../src/api/capacity/services/capacity/assignments/observability/operator-assignment-service.ts';
import { createProviderAssignmentService } from '../../../../../../../src/api/control-plane/repositories/providers/provider-assignment-service.ts';
import { recoveryAssignment } from '../cancellation-fixture.ts';

describe('authorized unresolved usage recovery', () => {
	it('reads the exact operator audit for released or disputed consumed reservation authority without invoking productive lifecycle operations', async () => {
		const assignment: ReturnType<typeof recoveryAssignment> = { ...recoveryAssignment(false), status: 'expired', metadata: { leaseRecovery: { disposition: 'operator-action' } } };
		const audit = { assignmentId: assignment.id, reservationId: assignment.reservationId, usageStatus: 'unresolved', settled: false,
			expectedStateVersion: assignment.stateVersion, actorId: 'operator', reason: 'Disputed automatic zero', recoveredAt: '2026-10-08T23:00:00.000Z' };
		const first = vi.fn().mockResolvedValue({ metadata_json: JSON.stringify(audit) });
		const unused = vi.fn(async () => { throw new Error('Audit read cannot invoke productive operations'); });
		const provider = createProviderAssignmentService({ getProviderAssignment: async () => assignment, first,
			ensureInitialized: unused, run: unused, all: unused, batch: unused,
			leaseNextProviderAssignment: unused, renewProviderAssignmentLease: unused, returnProviderAssignment: unused,
			completeProviderAssignment: unused, failProviderAssignment: unused,
			createCapacityWorkdayRun: unused, tickCapacityWorkdayRun: unused, updateCapacityWorkdayRun: unused });
		const principal = { principal: { teamId: assignment.teamId, capacityProviderId: assignment.capacityProviderId,
			membershipId: assignment.membershipId!, scopes: ['provider:assignments:read'] } };
		const before = structuredClone({ assignment, audit, principal });
		expect(await provider.show(principal, assignment.id)).toEqual({ ...assignment, unresolvedUsageRecovery: audit });
		const [sql, params] = first.mock.calls[0]!;
		expect(params).toEqual([assignment.reservationId, assignment.teamId, assignment.id, assignment.capacityProviderId, assignment.membershipId]);
		expect(sql).toContain("reservation.state='released'"); expect(sql).toContain("reservation.state='consumed'");
		expect(sql).toContain("assignment.settlement.disputed");
		first.mockResolvedValueOnce(null);
		expect(await provider.show(principal, assignment.id)).toEqual(assignment);
		await expect(provider.show({ principal: { ...principal.principal, capacityProviderId: 'foreign' } }, assignment.id)).rejects.toMatchObject({ status: 403 });
		expect(first).toHaveBeenCalledTimes(2); expect(unused).not.toHaveBeenCalled(); expect({ assignment, audit, principal }).toEqual(before);
	});
	it('requires exact original deadline zero identities and absent active clock without treating native or malformed facts as disputable', () => {
		const identity = { team_id: 'team', assignment_id: 'assignment', membership_id: 'member', capacity_provider_id: 'provider',
			execution_provider_id: 'executor', project_id: 'project', work_day_id: 'workday' };
		const row = { id: 'assignment', attempt_count: 1, capacity_envelope_json: JSON.stringify({ budget: { time: { executionStartedAt: null } } }) };
		const reservation = { ...identity, id: 'reservation', state: 'consumed', settlement_token: 'original-token', usage_report_token: null,
			active_seconds: 0, elapsed_seconds: 0, consumed_provider_units: null, consumed_usd: null };
		const entry = { ...identity, reservation_id: 'reservation', phase: 'task_completed_actual_settlement',
			source: 'capacity_workday_deadline_terminalization', active_seconds: 0, elapsed_seconds: 0, provider_units: null, usd: null };
		const actual = { assignment_id: 'assignment', capacity_provider_id: 'provider', execution_provider_id: 'executor', project_id: 'project',
			work_day_id: 'workday', id: 'usage:assignment:1:aggregate', assignment_attempt: 1, accounting_mode: 'aggregate',
			active_seconds: 0, elapsed_seconds: 0, native_usage_json: '{}', actual_usd: null };
		const before = structuredClone({ row, reservation, entry, actual });
		expect(isAutomaticUnknownZero(row, reservation, [entry], [actual])).toBe(true);
		for (const field of Object.keys(identity)) for (const value of [undefined, null, '', 'foreign'])
			expect(isAutomaticUnknownZero(row, reservation, [{ ...entry, [field]: value }], [actual])).toBe(false);
		for (const value of ['provider_actual', '', undefined]) expect(isAutomaticUnknownZero(row, reservation, [{ ...entry, source: value }], [actual])).toBe(false);
		for (const value of [undefined, null, '0', -1, 1, NaN, Infinity]) {
			for (const field of ['active_seconds', 'elapsed_seconds']) {
				expect(isAutomaticUnknownZero(row, reservation, [{ ...entry, [field]: value }], [actual])).toBe(false);
				expect(isAutomaticUnknownZero(row, reservation, [entry], [{ ...actual, [field]: value }])).toBe(false);
			}
		}
		for (const value of ['[]', 'null', 'bad', '{"tokens":0}', '{"tokens":1}'])
			expect(isAutomaticUnknownZero(row, reservation, [entry], [{ ...actual, native_usage_json: value }])).toBe(false);
		for (const value of ['', 'bad', '2026-10-08T20:00:00.000Z']) expect(isAutomaticUnknownZero(
			{ ...row, capacity_envelope_json: JSON.stringify({ budget: { time: { executionStartedAt: value } } }) }, reservation, [entry], [actual])).toBe(false);
		for (const field of ['input_tokens', 'cached_input_tokens', 'reasoning_tokens', 'output_tokens', 'actual_usd'])
			expect(isAutomaticUnknownZero(row, reservation, [entry], [{ ...actual, [field]: 1 }])).toBe(false);
		expect(isAutomaticUnknownZero(row, reservation, [], [actual])).toBe(false);
		expect(isAutomaticUnknownZero(row, reservation, [entry, entry], [actual])).toBe(false);
		expect(isAutomaticUnknownZero(row, reservation, [entry], [])).toBe(false);
		expect(isAutomaticUnknownZero(row, reservation, [entry], [actual, actual])).toBe(false);
		expect(isAutomaticUnknownZero(row, reservation, [entry], [actual, { accounting_mode: 'incremental' }])).toBe(false);
		expect({ row, reservation, entry, actual }).toEqual(before);
	});
	it('keeps settlement dispute authority server derived and rejects every caller hold refund settlement or measurement before recovery', async () => {
		const recoverCapacityAssignment = vi.fn(async (_team, _id, input) => input);
		const service = createAssignmentService({ recoverCapacityAssignment });
		const valid = { expectedStateVersion: 3, reason: 'Dispute automatic zero; actual active clock unavailable' };
		for (const field of ['settlementId', 'dispute', 'restoreAmount', 'releasedAmount', 'counterId', 'claimId', 'activeClock', 'usageSettlement']) {
			for (const value of [undefined, null, 0, 12, 'original', {}]) {
				const body = { ...valid, [field]: value }, before = structuredClone(body);
				await expect(service.recover({ id: 'operator', roles: ['admin'] }, 'team', 'expired', body, 'dispute'))
					.rejects.toMatchObject({ status: 400, code: 'capacity_recovery_input_invalid' });
				expect(body).toEqual(before);
			}
		}
		expect(recoverCapacityAssignment).not.toHaveBeenCalled();
		expect(await service.recover({ id: 'operator', roles: ['admin'] }, 'team', 'expired', valid, 'dispute'))
			.toEqual({ ...valid, actorId: 'operator', idempotencyKey: 'dispute' });
	});
	it('requires team management before unresolved recovery and derives actor and operation identity only from authenticated context', async () => {
		const recoverCapacityAssignment = vi.fn(async (_team, _id, input) => input);
		const store = { principalCanAccessTeam: vi.fn(async () => true),
			getTeamAccessSummary: vi.fn(async () => ({ permissions: ['teams:manage:team'] })), recoverCapacityAssignment };
		const service = createAssignmentService(store), body = { expectedStateVersion: 7, reason: 'Native clock unavailable' };
		const held = structuredClone(body);
		await expect(service.recover(undefined, 'team', 'expired', body, 'recovery')).rejects.toMatchObject({ status: 401 });
		store.principalCanAccessTeam.mockResolvedValueOnce(false);
		await expect(service.recover({ id: 'foreign' }, 'team', 'expired', body, 'recovery')).rejects.toMatchObject({ status: 403 });
		store.getTeamAccessSummary.mockResolvedValueOnce({ permissions: [] });
		await expect(service.recover({ id: 'reader' }, 'team', 'expired', body, 'recovery')).rejects.toMatchObject({ status: 403 });
		expect(recoverCapacityAssignment).not.toHaveBeenCalled();
		await expect(service.recover({ id: 'operator' }, 'team', 'expired', body, 'recovery'))
			.resolves.toEqual({ ...body, actorId: 'operator', idempotencyKey: 'recovery' });
		expect(recoverCapacityAssignment).toHaveBeenCalledTimes(1); expect(body).toEqual(held);
	});
	it('denies malformed version reason and every caller measurement or actor field before the owning recovery mutation', async () => {
		const recoverCapacityAssignment = vi.fn(), service = createAssignmentService({ recoverCapacityAssignment });
		const valid = { expectedStateVersion: 1, reason: 'Unresolved actual active clock' };
		const invalid = [null, {}, { ...valid, reason: '' }, { ...valid, reason: ' ' }, { ...valid, reason: 1 },
			...[undefined, null, '', '1', true, 0, -1, 0.5, NaN, Infinity].map(expectedStateVersion => ({ ...valid, expectedStateVersion })),
			...['actorId', 'activeSeconds', 'elapsedSeconds', 'usageActual', 'nativeUsage', 'usd', 'leaseToken', 'settled', 'usageStatus']
				.flatMap(field => [undefined, null, 0, 'supplied'].map(value => ({ ...valid, [field]: value })))];
		for (const body of invalid) {
			const held = structuredClone(body);
			await expect(service.recover({ id: 'admin', roles: ['admin'] }, 'team', 'expired', body, 'recovery'))
				.rejects.toMatchObject({ status: 400, code: 'capacity_recovery_input_invalid' });
			expect(body).toEqual(held);
		}
		expect(recoverCapacityAssignment).not.toHaveBeenCalled();
	});
});
