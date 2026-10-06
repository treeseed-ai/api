import { describe,expect,it } from 'vitest';
import { capacitySupplyCandidateStatus,selectCapacitySupply } from '../../../../src/api/capacity/policy/supply-selection.ts';

describe('capacity supply selection', () => {
	it('normalizes an active execution-provider lifecycle snapshot into available supply', () => {
		expect(capacitySupplyCandidateStatus('active')).toBe('available');
		expect(capacitySupplyCandidateStatus('unavailable')).toBe('unavailable');
		expect(selectCapacitySupply({
			candidates: [{ capacityProviderId: 'provider-1', membershipId: 'membership-1', providerSessionId: 'session-1',
				grantId: 'grant-1', executionProviderId: 'codex-local', status: capacitySupplyCandidateStatus('active'),
				capabilities: ['treeseed.coordination.conversation'], reliability: 1, pressure: 'idle', availableConcurrency: 1 }],
			requiredCapabilities: ['treeseed.coordination.conversation'],
			policy: { generation: 1, reliabilityFloor: 0, maxFailovers: 0, allowPlanningFailover: false, allowActingFailover: false },
		}).selected).toMatchObject({ executionProviderId: 'codex-local', status: 'available' });
	});
	it('does not turn a stale provider minimum into an agent execution floor', () => {
		const selection = selectCapacitySupply({
			candidates: [{ capacityProviderId: 'provider-1', membershipId: 'membership-1', providerSessionId: 'session-1',
				grantId: 'grant-1', executionProviderId: 'codex-implementation', status: 'available',
				capabilities: ['implementation'], reliability: 1, pressure: 'idle', availableConcurrency: 1,
				minimumAssignmentDuration: { amount: 3600, unit: 'seconds' } } as never],
			requiredCapabilities: ['implementation'],
			policy: { generation: 1, reliabilityFloor: 0, maxFailovers: 0, allowPlanningFailover: false, allowActingFailover: false },
			assignmentWindow: { startedAt: '2026-09-29T00:00:00.000Z', durationSeconds: 30 },
		});
		expect(selection.selected?.executionProviderId).toBe('codex-implementation');
	});
});
