import { describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createGovernanceOperations } from '../../../src/api/control-plane/catalog/governance-operations.ts';

describe('governance catalog read operations', () => {
	it('binds proposal and decision reads without transport knowledge', async () => {
		const governance = {
			approvals: vi.fn(async () => ({ items: [] })), approval: vi.fn(async () => ({ approval: { id: 'approval-1' } })),
			decideApproval: vi.fn(async () => ({ id: 'approval-1', state: 'approved' })),
			createProposal: vi.fn(async () => ({ id: 'proposal-1' })), updateProposal: vi.fn(async () => ({ proposal: { id: 'proposal-1' } })),
			openProposal: vi.fn(async () => ({ id: 'proposal-1', status: 'open' })), startVoting: vi.fn(async () => ({ id: 'proposal-1', status: 'voting' })),
			vote: vi.fn(async () => ({ id: 'proposal-1' })), evaluate: vi.fn(async () => ({ id: 'proposal-1' })),
			withdraw: vi.fn(async () => ({ id: 'proposal-1', status: 'withdrawn' })), supersede: vi.fn(async () => ({ id: 'proposal-1', status: 'superseded' })),
			proposals: vi.fn(async () => ({ items: [] })), proposal: vi.fn(async () => ({ id: 'proposal-1' })),
			proposalEvents: vi.fn(async () => ({ items: [] })), decisions: vi.fn(async () => ({ items: [] })),
			decision: vi.fn(async () => ({ id: 'decision-1' })), decisionEvents: vi.fn(async () => ({ items: [] })),
		};
		const operations = createGovernanceOperations({ governance });
		expect(operations.map((operation) => operation.binding)).toEqual([
			CONTROL_PLANE_OPERATIONS.governance.approvals, CONTROL_PLANE_OPERATIONS.governance.approval,
			CONTROL_PLANE_OPERATIONS.governance.decideApproval,
			CONTROL_PLANE_OPERATIONS.governance.createProposal, CONTROL_PLANE_OPERATIONS.governance.updateProposal,
			CONTROL_PLANE_OPERATIONS.governance.openProposal, CONTROL_PLANE_OPERATIONS.governance.startVoting,
			CONTROL_PLANE_OPERATIONS.governance.vote, CONTROL_PLANE_OPERATIONS.governance.evaluate,
			CONTROL_PLANE_OPERATIONS.governance.withdraw, CONTROL_PLANE_OPERATIONS.governance.supersede,
			CONTROL_PLANE_OPERATIONS.governance.proposals, CONTROL_PLANE_OPERATIONS.governance.proposal,
			CONTROL_PLANE_OPERATIONS.governance.proposalEvents, CONTROL_PLANE_OPERATIONS.governance.decisions,
			CONTROL_PLANE_OPERATIONS.governance.decision, CONTROL_PLANE_OPERATIONS.governance.decisionEvents,
		]);
		const context = { interface: 'rest' as const, requestId: 'request-1', principal: { id: 'user-1' } };
		await operations[12].handler({ path: { projectId: 'project-1', proposalId: 'proposal-1' }, query: {}, body: undefined }, context);
		expect(governance.proposal).toHaveBeenCalledWith(context.principal, 'project-1', 'proposal-1');
		await operations[4].handler({ path: { projectId: 'project-1', proposalId: 'proposal-1' }, query: {}, body: { title: 'Updated' } },
			{ ...context, ifMatch: '3' });
		expect(governance.updateProposal).toHaveBeenCalledWith(context.principal, 'project-1', 'proposal-1', { title: 'Updated' }, '3');
	});
});
