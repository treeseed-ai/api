import { describe, expect, it, vi } from 'vitest';
import { createGovernanceService, GovernanceServiceError } from '../../../src/api/control-plane/governance/governance-service.ts';
import { commitProposalVersionContent } from '../../../src/api/control-plane/governance/proposal-version-content.ts';

vi.mock('../../../src/api/control-plane/governance/proposal-version-content.ts', () => ({ commitProposalVersionContent: vi.fn() }));

function fixture(proposalProjectId = 'project-1') {
	const store = {
		getProjectDetails: vi.fn(async () => ({ project: { id: 'project-1', teamId: 'team-1' } })),
		principalCanAccessTeam: vi.fn(async () => true),
		getTeamAccessSummary: vi.fn(async () => ({ permissions: ['projects:read:team', 'projects:manage:team'] })),
		getGovernanceProposal: vi.fn(async () => ({ id: 'proposal-1', projectId: proposalProjectId, activeVersion: 3, metadata: {} })),
		updateGovernanceProposalDraft: vi.fn(async () => ({ id: 'proposal-1', activeVersion: 3 })),
		getApprovalRequest: vi.fn(async () => ({ id: 'approval-1', projectId: 'project-1', updatedAt: '2026-08-22T12:00:00.000Z' })),
		listApprovalRequestsForProject: vi.fn(async () => []),
		decideApprovalRequest: vi.fn(async (_id, input) => ({ id: 'approval-1', state: input.state, decision: input.decision })),
	};
	return { store, service: createGovernanceService(store), principal: { id: 'user-1', roles: ['member'] } };
}

describe('governance service mutation boundaries', () => {
	it('authors a draft when replay repair requires immutable provenance', async () => {
		const { store, service, principal } = fixture();
		store.updateGovernanceProposalDraft.mockRejectedValueOnce(Object.assign(new Error('Authoring required.'), { code: 'governance_proposal_repair_material_change' }));
		const receipt = { path: 'proposals/test.md', commitSha: 'a'.repeat(40) };
		const update = { expectedProposalVersion: 3, contentProvenance: receipt };
		vi.mocked(commitProposalVersionContent).mockResolvedValueOnce({ receipt, update } as unknown as Awaited<ReturnType<typeof commitProposalVersionContent>>);
		const result = await service.updateProposal(principal, 'project-1', 'proposal-1', { changeReason: 'Publish draft.' }, '3');
		expect(result).toMatchObject({ idempotentReplay: false, authoringReceipt: receipt });
		expect(store.updateGovernanceProposalDraft).toHaveBeenLastCalledWith(principal, 'proposal-1', update);
	});

	it('does not bind a new version when authoring fails', async () => {
		const { store, service, principal } = fixture();
		store.updateGovernanceProposalDraft.mockRejectedValueOnce(Object.assign(new Error('Authoring required.'), { code: 'governance_proposal_repair_material_change' }));
		vi.mocked(commitProposalVersionContent).mockRejectedValueOnce(Object.assign(new Error('Reconcile the missing proposal type.'), { status: 422, code: 'proposal_type_contract_missing' }));
		await expect(service.updateProposal(principal, 'project-1', 'proposal-1', { changeReason: 'Publish draft.' }, '3')).rejects.toMatchObject({ status: 422, code: 'proposal_type_contract_missing' });
		expect(store.updateGovernanceProposalDraft).toHaveBeenCalledOnce();
	});

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

	it('decides the exact approval without building an agent summary projection', async () => {
		const { store, service, principal } = fixture();
		const result = await service.decideApproval(principal, 'project-1', 'approval-1',
			{ decision: 'request_changes', reason: 'Add evidence.' }, '2026-08-22T12:00:00.000Z');
		expect(result).toMatchObject({ state: 'rejected', decision: { decision: 'request_changes', reason: 'Add evidence.' } });
		expect(store.decideApprovalRequest).toHaveBeenCalledWith('approval-1', expect.objectContaining({
			state: 'rejected', decidedByType: 'user', decidedById: 'user-1',
		}));
	});

	it('rejects service-principal approval decisions', async () => {
		const { store, service } = fixture();
		await expect(service.decideApproval({ id: 'service-1', metadata: { serviceId: 'runner' } }, 'project-1', 'approval-1',
			{ decision: 'approve' }, '2026-08-22T12:00:00.000Z')).rejects.toMatchObject({
				status: 403, code: 'service_approval_decision_forbidden',
			});
		expect(store.decideApprovalRequest).not.toHaveBeenCalled();
	});

	it('rejects governance mutation when a member lacks project management authority', async () => {
		const { store, service, principal } = fixture();
		store.getTeamAccessSummary.mockResolvedValue({ permissions: ['projects:read:team'] });
		await expect(service.createProposal(principal, 'project-1', { title: 'Unauthorized' })).rejects.toMatchObject({
			status: 403, code: 'project_permission_denied',
		});
	});
});
