import { describe, expect, it } from 'vitest';
import { governanceProposalReadinessMethod } from '../../../../../src/api/store/governance/policy/contracts/governance-proposal-readiness.ts';
import type { ControlPlaneStore } from '../../../../../src/api/persistence/store.ts';

describe('human proposal review freshness', () => {
	it.each([undefined, 3, 4])('counts only current review version %s even without an agent participation snapshot', async proposalVersion => {
		const store = { getGovernanceProposal: async () => ({ id: 'human-proposal', projectId: 'project-1', activeVersion: 4, createdById: 'author', metadata: {} }),
			first: async () => null,
			all: async (query: string) => query.includes('FROM governance_events') ? [{ id: 'review-1', actor_id: 'independent-reviewer', event_type: 'proposal.discussion', evidence_json: { kind: 'support', proposalVersion } }] : [] };
		const readiness = await governanceProposalReadinessMethod.call(store as unknown as ControlPlaneStore, 'human-proposal');
		expect(readiness?.independentReviewCount).toBe(proposalVersion === 4 ? 1 : 0);
	});
	it('does not treat retired proposal signals as review authority', async () => {
		const store = { getGovernanceProposal: async () => ({ id: 'human-proposal', projectId: 'project-1', activeVersion: 4, createdById: 'author', metadata: {} }),
			first: async () => null,
			all: async () => [] };
		const readiness = await governanceProposalReadinessMethod.call(store as unknown as ControlPlaneStore, 'human-proposal');
		expect(readiness?.independentReviewCount).toBe(0);
	});
	it('accepts only an accepted graph plan bound to the current proposal revision and digest', async () => {
		const digest = 'd'.repeat(64);
		const store = {
			getGovernanceProposal: async () => ({ id: 'human-proposal', teamId: 'team-1', projectId: 'project-1', activeVersion: 4,
				activeContentHash: digest, createdById: 'author', metadata: {} }),
			all: async () => [],
			first: async () => ({ node_json: { proposalRef: { revision: 4, digest } } }),
		};
		const readiness = await governanceProposalReadinessMethod.call(store as unknown as ControlPlaneStore, 'human-proposal');
		expect(readiness?.missingVoting).not.toContain('exact accepted execution plan');
	});
});
