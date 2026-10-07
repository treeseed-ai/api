import { describe, expect, it, vi } from 'vitest';
import { adminApprovalProvider } from '../../../../src/api/governance/voting.ts';
import { ControlPlaneStore, serializeGovernanceProposal } from '../../../../src/api/persistence/store.ts';

const voter = {
	userId: 'admin-1',
	activeForQuorum: true,
	chambers: [{ chamberId: 'admin_chamber', eligible: true, weight: 1, source: 'team-role', evidence: {} }],
};

function suppliedProposal() {
		const original = serializeGovernanceProposal({ id: 'proposal', team_id: 'team', project_id: 'project', scope: 'project',
			status: 'open', title: 'Scope custody', summary: '', body: 'Controlled unit input', proposal_type: 'implementation',
			proposal_types_json: '["implementation"]', content_proposal_slug: null, content_decision_slug: null,
			active_version: 1, active_content_hash: 'a'.repeat(64), governance_provider_id: 'admin-approval',
			governance_provider_version: '1', governance_policy_id: null, decision_id: null,
			voting_starts_at: null, voting_ends_at: null, closed_at: null, closed_reason: null,
			created_by_type: 'user', created_by_id: 'operator', metadata_json: '{}',
			created_at: '2026-10-06T00:00:00.000Z', updated_at: '2026-10-06T00:00:00.000Z' });
		if (!original) throw new Error('Complete original row required');
		return original;
}

describe('admin governance voting', () => {
	it('denies missing electorate readback before evaluating votes or changing the retained proposal', async () => {
		const proposal = suppliedProposal(), held = structuredClone(proposal);
		const store = new ControlPlaneStore({}, { prepare: () => { throw new Error('Missing electorate must not reach downstream SQL'); } });
		store.initializationPromise = Promise.resolve();
		const read = vi.spyOn(store, 'getGovernanceProposal').mockResolvedValue(proposal);
		const latest = vi.spyOn(store, 'latestGovernanceElectorateSnapshot').mockResolvedValue(null);
		const snapshot = vi.spyOn(store, 'snapshotGovernanceElectorate').mockResolvedValue(null);
		const votes = vi.spyOn(store, 'effectiveGovernanceVotes').mockResolvedValue([]);
		const input = { adminDecision: 'rejected', expectedProposalVersion: 1 }, originalInput = structuredClone(input);
		for (const result of await Promise.allSettled([store.evaluateGovernanceProposal('proposal', input), store.evaluateGovernanceProposal('proposal', input)])) {
			expect(result.status).toBe('rejected');
			if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 409, code: 'governance_electorate_required' });
		}
		await expect(store.evaluateGovernanceProposal('proposal', input)).rejects.toMatchObject({ status: 409, code: 'governance_electorate_required' });
		expect(votes).not.toHaveBeenCalled(); expect(proposal).toEqual(held); expect(input).toEqual(originalInput);
		read.mockRestore(); latest.mockRestore(); snapshot.mockRestore(); votes.mockRestore();
	});
	it('denies every malformed persisted proposal scope before electorate policy reads or writes without normalizing authority', async () => {
		const original = suppliedProposal();
		const store = new ControlPlaneStore({}, { prepare: () => { throw new Error('Invalid scope must not reach downstream SQL'); } });
		store.initializationPromise = Promise.resolve();
		const read = vi.spyOn(store, 'getGovernanceProposal');
		for (const scope of [undefined, null, '', ' ', ' project', 'project ', 'TEAM', 'unknown', 0, false, [], {}]) {
			const proposal = Object.assign(structuredClone(original), { scope }), held = structuredClone(proposal);
			read.mockResolvedValue(proposal);
			for (const result of await Promise.allSettled([store.snapshotGovernanceElectorate('proposal'), store.snapshotGovernanceElectorate('proposal')])) {
				expect(result.status).toBe('rejected');
				if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 409, code: 'governance_proposal_scope_invalid' });
			}
			await expect(store.snapshotGovernanceElectorate('proposal')).rejects.toMatchObject({ status: 409, code: 'governance_proposal_scope_invalid' });
			expect(proposal).toEqual(held);
		}
		read.mockRestore();
	});
	it('accepts an eligible administrator support vote without waiting for the voting deadline', async () => {
		const electorate = await adminApprovalProvider.snapshotElectorate({
			teamId: 'team-1', projectId: 'project-1', scope: 'project', providerConfig: {}, eligibleVoters: [voter],
		});
		expect(adminApprovalProvider.evaluate({
			electorate, votes: [{ userId: voter.userId, vote: 'support' }], votingEndsAt: '2099-01-01T00:00:00.000Z',
		})).toMatchObject({ status: 'accepted', reasonCode: 'admin_approved', decisionEligible: true });
	});

	it('rejects an eligible administrator objection without waiting for the voting deadline', async () => {
		const electorate = await adminApprovalProvider.snapshotElectorate({
			teamId: 'team-1', projectId: 'project-1', scope: 'project', providerConfig: {}, eligibleVoters: [voter],
		});
		expect(adminApprovalProvider.evaluate({
			electorate, votes: [{ userId: voter.userId, vote: 'object' }], votingEndsAt: '2099-01-01T00:00:00.000Z',
		})).toMatchObject({ status: 'rejected', reasonCode: 'admin_rejected', decisionEligible: false });
	});
});
