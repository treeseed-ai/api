import { describe, expect, it } from 'vitest';
import { adminApprovalProvider } from '../../../../src/api/governance/voting.ts';

const voter = {
	userId: 'admin-1',
	activeForQuorum: true,
	chambers: [{ chamberId: 'admin_chamber', eligible: true, weight: 1, source: 'team-role', evidence: {} }],
};

describe('admin governance voting', () => {
	it('accepts an eligible administrator support vote without waiting for the voting deadline', () => {
		const electorate = adminApprovalProvider.snapshotElectorate({
			teamId: 'team-1', projectId: 'project-1', scope: 'project', providerConfig: {}, eligibleVoters: [voter],
		});
		expect(adminApprovalProvider.evaluate({
			electorate, votes: [{ userId: voter.userId, vote: 'support' }], votingEndsAt: '2099-01-01T00:00:00.000Z',
		})).toMatchObject({ status: 'accepted', reasonCode: 'admin_approved', decisionEligible: true });
	});

	it('rejects an eligible administrator objection without waiting for the voting deadline', () => {
		const electorate = adminApprovalProvider.snapshotElectorate({
			teamId: 'team-1', projectId: 'project-1', scope: 'project', providerConfig: {}, eligibleVoters: [voter],
		});
		expect(adminApprovalProvider.evaluate({
			electorate, votes: [{ userId: voter.userId, vote: 'object' }], votingEndsAt: '2099-01-01T00:00:00.000Z',
		})).toMatchObject({ status: 'rejected', reasonCode: 'admin_rejected', decisionEligible: false });
	});
});
