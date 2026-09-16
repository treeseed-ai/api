import { describe, expect, it, vi } from 'vitest';
import { livingAllocationInputs } from '../../../../../../src/api/capacity/services/capacity/assignments/admission/living-allocation-inputs.ts';

const now = '2026-09-16T12:30:00.000Z';
const plan = { schemaVersion: 'treeseed.workday/v1', id: 'workday', teamId: 'team', policyId: 'default', policyRevision: 1,
	executionMode: 'simulation', state: 'active', startsAt: '2026-09-16T12:00:00.000Z', endsAt: '2026-09-16T14:00:00.000Z',
	policySnapshot: { durationSeconds: 7200, maximumConcurrency: 1, communicationConcurrency: 1, planningPercent: 20,
		allocationWeight: 1, planningTurnMaximumSeconds: 180, projectPercentages: { project: 100 },
		agentClassPercentages: { project: { engineer: 100 } } }, planningRounds: [],
	admittedSecondsByProject: {}, admittedSecondsByAgentClass: {} };
const run = { id: 'workday', teamId: 'team', parameters: { appliedPlan: plan } };
const observation = { day: '2026-09-16', observedAt: now, healthy: true, activeSeconds: 10, reservedSeconds: 0 };
const provider = { id: 'codex-implementation', accountingLimits: { modelConfigurationId: 'terra-medium',
	dailyActiveSecondsLimit: 1000, capabilityLimits: { implementation: { dailyActiveSecondsLimit: 1000 } } },
	accountingObservation: { modelUsage: observation, capabilityUsage: { implementation: observation } } };

describe('live allocation ledger inputs', () => {
	it('counts unreported API reservations once and includes other capabilities in the shared model budget', async () => {
		const store = { all: vi.fn(async (sql: string) => sql.includes('capacity_reservations') ? [
			{ work_day_id: 'other', mode: 'acting', state: 'consuming', reserved_seconds: 300, active_seconds: 100, capability_id: 'implementation' },
			{ work_day_id: 'other', mode: 'acting', state: 'consumed', reserved_seconds: 500, active_seconds: 200, capability_id: 'analysis' },
		] : []), first: vi.fn(async () => ({ ready_count: 1 })) };
		const result = await livingAllocationInputs(store as never, { run: run as never, runs: [run as never], providers: [provider as never],
			capacityProviderId: 'provider', capabilityId: 'implementation', agentClass: 'engineer', activity: 'act', now });
		expect(result['codex-implementation']?.constraints).toEqual([{ id: 'workday-phase-share', remainingSeconds: 500 }]);
		expect(store.all.mock.calls.filter(([sql]) => sql.includes('capacity_reservations'))).toHaveLength(1);
	});
	it('uses the greater provider total rather than adding duplicate observed consumption', async () => {
		const store = { all: vi.fn(async () => []), first: vi.fn(async () => ({ ready_count: 1 })) };
		const result = await livingAllocationInputs(store as never, { run: run as never, runs: [run as never],
			providers: [{ ...provider, accountingObservation: { modelUsage: { ...observation, activeSeconds: 300, reservedSeconds: 200 },
				capabilityUsage: { implementation: observation } } } as never], capacityProviderId: 'provider', capabilityId: 'implementation',
			agentClass: 'engineer', activity: 'act', now });
		expect(result['codex-implementation']?.constraints[0]?.remainingSeconds).toBe(500);
	});
});
