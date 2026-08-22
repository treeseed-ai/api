import { describe, expect, it, vi } from 'vitest';
import { createGovernanceService, GovernanceServiceError } from '../../../src/api/control-plane/governance/governance-service.ts';

function fixture(proposalProjectId = 'project-1') {
	const store = {
		getProjectDetails: vi.fn(async () => ({ project: { id: 'project-1', teamId: 'team-1' } })),
		principalCanAccessTeam: vi.fn(async () => true),
		getGovernanceProposal: vi.fn(async () => ({ id: 'proposal-1', projectId: proposalProjectId, activeVersion: 3, metadata: {} })),
		updateGovernanceProposalDraft: vi.fn(async () => ({ id: 'proposal-1', activeVersion: 3 })),
	};
	return { store, service: createGovernanceService(store), principal: { id: 'user-1', roles: ['member'] } };
}

describe('governance service mutation boundaries', () => {
	it('binds If-Match to the exact proposal version before updating', async () => {
		const { store, service, principal } = fixture();
		const result = await service.updateProposal(principal, 'project-1', 'proposal-1',
			{ title: 'Same content', expectedProposalVersion: 3 }, '3');
		expect(result).toMatchObject({ idempotentReplay: true });
		expect(store.updateGovernanceProposalDraft).toHaveBeenCalledWith(principal, 'proposal-1',
			expect.objectContaining({ expectedProposalVersion: 3, repairExistingVersion: true }));
	});

	it('rejects contradictory concurrency evidence without mutating', async () => {
		const { store, service, principal } = fixture();
		await expect(service.updateProposal(principal, 'project-1', 'proposal-1',
			{ expectedProposalVersion: 2 }, '3')).rejects.toMatchObject<Partial<GovernanceServiceError>>({
				status: 412, code: 'proposal_precondition_mismatch',
			});
		expect(store.updateGovernanceProposalDraft).not.toHaveBeenCalled();
	});

	it('checks project ownership before any proposal mutation', async () => {
		const { store, service, principal } = fixture('project-2');
		await expect(service.openProposal(principal, 'project-1', 'proposal-1', {}, '3')).rejects.toMatchObject({
			status: 404, code: 'governance_proposal_not_found',
		});
		expect((store as any).openGovernanceProposal).toBeUndefined();
	});
});
