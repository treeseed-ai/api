import { describe, expect, it, vi } from 'vitest';

const exact = vi.hoisted(() => ({ definition: { id: 'proposal', projectId: 'project', status: 'draft',
	request: 'Implement the existing contract.', executionPlan: { workItems: [
		{ id: 'implementation', objective: 'Implement the contract.', review: 'required' },
	] } } }));
vi.mock('../../../../../src/api/governance/executable-proposal.ts', async (importOriginal) => ({
	...await importOriginal<typeof import('../../../../../src/api/governance/executable-proposal.ts')>(),
	readExactProposal: vi.fn(async () => exact),
}));

import { adminDecideGovernanceProposalMethod } from '../../../../../src/api/store/governance/policy/contracts/admin-decide-governance-proposal.ts';

describe('external approval before estimates', () => {
	it('records external approval without creating an unestimated decision', async () => {
		const proposal = { id: 'proposal', teamId: 'team', projectId: 'project', activeVersion: 1, status: 'open' };
		const store = { getGovernanceProposal: vi.fn(async () => proposal),
			recordGovernanceEvent: vi.fn(async () => undefined), evaluateGovernanceProposal: vi.fn() };
		const result = await adminDecideGovernanceProposalMethod.call(store as never,
			{ id: 'human' }, 'proposal', { status: 'approved', reason: 'Approved for execution.', expectedProposalVersion: 1 });
		expect(result).toMatchObject({ pendingEstimates: true, status: 'open' });
		expect(store.evaluateGovernanceProposal).not.toHaveBeenCalled();
		expect(store.recordGovernanceEvent).toHaveBeenCalledWith(expect.objectContaining({
			eventType: 'proposal.admin_decision', actorType: 'user', actorId: 'human', nextState: 'approved',
			evidence: expect.objectContaining({ pendingEstimates: true, approvalFingerprint: expect.any(String) }),
		}));
	});
});
