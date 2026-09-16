import { describe, expect, it, vi } from 'vitest';
import { compileWorkday } from '@treeseed/sdk/agent-capacity';
import { livingAllocationInputs } from '../../../../../../src/api/capacity/services/capacity/assignments/admission/living-allocation-inputs.ts';

describe('bounded closing workday allocation', () => {
	it('counts only the graph-ready Reporter and uses its exact maximum beyond the productive window', async () => {
		const now = '2026-09-16T12:30:00.000Z', capabilityId = 'treeseed.coordination.reporting';
		const plan = { ...compileWorkday({ id: 'closing', teamId: 'team', policyId: 'default', policyRevision: 1,
			executionMode: 'simulation', startsAt: '2026-09-16T12:00:00.000Z', agentIds: [],
			policy: { durationSeconds: 600, maximumConcurrency: 1, communicationConcurrency: 1 } }), state: 'closing' };
		const run = { id: 'closing', teamId: 'team', parameters: { appliedPlan: plan } };
		const observation = { day: now.slice(0, 10), observedAt: now, healthy: true, activeSeconds: 0, reservedSeconds: 0 };
		const provider = { id: 'codex-implementation', accountingLimits: { modelConfigurationId: 'terra',
			dailyActiveSecondsLimit: 20, capabilityLimits: { [capabilityId]: { dailyActiveSecondsLimit: 20 } } },
			accountingObservation: { modelUsage: observation, capabilityUsage: { [capabilityId]: observation } } };
		const first = vi.fn(async (_query: string, _params: unknown[]) => ({ ready_count: 1, maximum_seconds: 30 }));
		const store = { first, all: vi.fn(async () => []) };
		const result = await livingAllocationInputs(store as never, { run: run as never, runs: [run] as never,
			providers: [provider] as never, capacityProviderId: 'provider', capabilityId, agentClass: 'reporter', activity: 'reporting', now });
		expect(first.mock.calls[0]?.[0]).toContain("kind='reporting'");
		expect(result['codex-implementation']?.constraints).toEqual([{ id: 'workday-phase-share', remainingSeconds: 20 }]);
	});
});
