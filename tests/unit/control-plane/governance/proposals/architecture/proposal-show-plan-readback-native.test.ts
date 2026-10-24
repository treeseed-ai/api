import { describe, expect, it } from 'vitest';
import { createGovernanceService } from '../../../../../../src/api/control-plane/governance/governance-service.ts';
import { proposalNativeFixture } from './proposal-native-fixture.ts';
import { readyContributionProposal } from './ready-proposal-fixture.ts';

describe('native shared proposal detail read', () => {
	it('returns the authored plan from the exact TreeDX source and distinguishes absence, source failure, and project denial', async () => {
		const native = await proposalNativeFixture();
		try {
			const definition = readyContributionProposal();
			const item = definition.executionPlan.workItems[0] as Record<string, unknown>;
			delete item.requiredCapabilities;
			item.estimateRef = { store: 'postgresql', model: 'assignment-attempt', id: 'authored-estimate', revision: 7 };
			const authoredPlan = structuredClone(definition.executionPlan);
			let exact = await native.publish(definition);
			let row = { id: 'proposal', projectId: 'project', teamId: 'team', activeVersion: 1,
				activeContentHash: exact.digest, metadata: { contentProvenance: { repositoryId: 'repository',
					contentPath: 'proposals/proposal.mdx', commitSha: exact.commit, digest: exact.digest } } };
			const store = {
				...native.store,
				getProjectDetails: async () => ({ project: { id: 'project', teamId: 'team' } }),
				principalCanAccessTeam: async (_principal: unknown, teamId: string) => teamId === 'team',
				getGovernanceProposal: async () => row,
				listGovernanceProposalVotes: async () => [],
				listGovernanceEvents: async () => [],
				governanceProposalReadiness: async () => ({ contentReady: true }),
				getGovernanceDecision: async () => null,
			};
			const service = createGovernanceService(store, {});
			const principal = { id: 'reader', roles: ['member'] };

			const detail = await service.proposal(principal, 'project', 'proposal');
			expect(detail.executionPlan).toEqual(authoredPlan);
			expect(detail.executionPlan.workItems[0]).not.toHaveProperty('requiredCapabilities');
			expect(detail.executionPlan.workItems[0].estimateRef).toEqual(item.estimateRef);
			expect(detail).toMatchObject({ votes: [], events: [], readiness: { contentReady: true }, decision: null });

			const withoutPlan = { ...definition };
			delete (withoutPlan as Record<string, unknown>).executionPlan;
			exact = await native.publish(withoutPlan);
			row = { ...row, activeContentHash: exact.digest, metadata: { contentProvenance: { repositoryId: 'repository',
				contentPath: 'proposals/proposal.mdx', commitSha: exact.commit, digest: exact.digest } } };
			await expect(service.proposal(principal, 'project', 'proposal')).resolves.toMatchObject({ executionPlan: null });

			for (const fault of ['denied', 'moved'] as const) {
				native.setFault(fault);
				await expect(service.proposal(principal, 'project', 'proposal')).rejects.toThrow();
			}
			native.setFault('none');
			row = { ...row, activeContentHash: 'f'.repeat(64) };
			await expect(service.proposal(principal, 'project', 'proposal')).rejects.toMatchObject({ code: 'proposal_digest_mismatch' });
			row = { ...row, activeContentHash: exact.digest };
			const invalid = { ...definition, executionPlan: { workItems: [] } };
			exact = await native.publish(invalid);
			row = { ...row, activeContentHash: exact.digest, metadata: { contentProvenance: { repositoryId: 'repository',
				contentPath: 'proposals/proposal.mdx', commitSha: exact.commit, digest: exact.digest } } };
			await expect(service.proposal(principal, 'project', 'proposal')).rejects.toMatchObject({
				status: 422, code: 'proposal_execution_plan_invalid',
			});
			await expect(service.proposal({ id: 'outsider' }, 'project', 'proposal')).rejects.toMatchObject({
				status: 403, code: 'project_access_denied',
			});
		} finally {
			await native.close();
		}
	});
});
