import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../src/api/governance/executable-proposal.ts', async (importOriginal) => {
	const original = await importOriginal<typeof import('../../../../../src/api/governance/executable-proposal.ts')>();
	return { ...original, readExactProposal: vi.fn(async () => ({ definition: {
		status: 'draft', executionPlan: { workItems: [{ estimate: { expectedSeconds: 30, maximumSeconds: 60 },
			review: 'required', reviewEstimate: { expectedSeconds: 10, maximumSeconds: 20 } }] },
	} })) };
});
vi.mock('../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts',
	() => ({ reconcileExecutionGraph: vi.fn(async () => undefined) }));

import { governanceProposalReadinessMethod } from '../../../../../src/api/store/governance/policy/contracts/governance-proposal-readiness.ts';
import { createGovernanceDecisionFromProposalMethod } from '../../../../../src/api/store/governance/policy/creation/create-governance-decision-from-proposal.ts';

describe('draft proposal graph readiness', () => {
	it('uses the exact complete draft without requiring a separate feasibility Reviewer', async () => {
		const store = {
			getGovernanceProposal: async () => ({ id: 'proposal', projectId: 'project', activeVersion: 1, createdById: 'author' }),
			all: async () => [],
		};
		const readiness = await governanceProposalReadinessMethod.call(store as never, 'proposal');
		expect(readiness).toMatchObject({ executionPlanReady: true, independentReviewCount: 0,
			unresolvedBlockerCount: 0, votingReady: true });
	});
	it('accepts the same reviewed draft version as decision authority', async () => {
		const proposal = { id: 'proposal', teamId: 'team', projectId: 'project', activeVersion: 1,
			activeContentHash: 'digest', metadata: {}, governanceProviderId: 'default' };
		const run = vi.fn(async () => undefined);
		const store = { ensureInitialized: async () => undefined, getGovernanceProposal: async () => proposal,
			getGovernanceDecision: async () => ({ id: 'decision' }), first: async () => null,
			effectiveGovernanceVotes: async () => [], run, recordGovernanceEvent: async () => undefined };
		await expect(createGovernanceDecisionFromProposalMethod.call(store as never, proposal.id))
			.resolves.toEqual({ id: 'decision' });
		expect(run).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO governance_decisions'), expect.any(Array));
	});
});
