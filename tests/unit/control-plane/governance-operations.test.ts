import { describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createGovernanceOperations } from '../../../src/api/control-plane/catalog/governance-operations.ts';

describe('governance catalog read operations', () => {
	it('binds proposal and decision reads without transport knowledge', async () => {
		const governanceReader = {
			proposals: vi.fn(async () => ({ items: [] })), proposal: vi.fn(async () => ({ id: 'proposal-1' })),
			proposalEvents: vi.fn(async () => ({ items: [] })), decisions: vi.fn(async () => ({ items: [] })),
			decision: vi.fn(async () => ({ id: 'decision-1' })), decisionEvents: vi.fn(async () => ({ items: [] })),
		};
		const operations = createGovernanceOperations({ governanceReader });
		expect(operations.map((operation) => operation.binding)).toEqual([
			CONTROL_PLANE_OPERATIONS.governance.proposals, CONTROL_PLANE_OPERATIONS.governance.proposal,
			CONTROL_PLANE_OPERATIONS.governance.proposalEvents, CONTROL_PLANE_OPERATIONS.governance.decisions,
			CONTROL_PLANE_OPERATIONS.governance.decision, CONTROL_PLANE_OPERATIONS.governance.decisionEvents,
		]);
		const context = { interface: 'rest' as const, requestId: 'request-1', principal: { id: 'user-1' } };
		await operations[1].handler({ path: { projectId: 'project-1', proposalId: 'proposal-1' }, query: {}, body: undefined }, context);
		expect(governanceReader.proposal).toHaveBeenCalledWith(context.principal, 'project-1', 'proposal-1');
	});
});
