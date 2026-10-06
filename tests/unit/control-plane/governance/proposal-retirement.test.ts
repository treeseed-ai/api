import { describe, expect, it, vi } from 'vitest';
import { transitionGovernanceProposalMethod } from '../../../../src/api/store/governance/policy/updates/transition-governance-proposal.ts';

describe('proposal retirement', () => {
	it.each(['withdrawn', 'superseded'])('retires an accepted decision when its proposal becomes %s', async (nextState) => {
		const existing = { id: 'proposal', teamId: 'team', projectId: 'project', activeVersion: 3,
			status: 'accepted', decisionId: 'decision', closedAt: null, closedReason: null };
		const store = {
			ensureInitialized: vi.fn(),
			getGovernanceProposal: vi.fn().mockResolvedValueOnce(existing).mockResolvedValueOnce({ ...existing, status: nextState }),
			batch: vi.fn(),
			recordGovernanceEvent: vi.fn(),
		};
		await transitionGovernanceProposalMethod.call(store as never, 'proposal', nextState, { reason: 'Acceptance reset.' });
		expect(store.batch).toHaveBeenCalledOnce();
		const operations = store.batch.mock.calls[0]![0];
		expect(operations).toHaveLength(2);
		expect(operations[1]).toMatchObject({ params: [expect.any(String), expect.any(String), 'decision'] });
		expect(operations[1].query).toContain('superseded_at');
	});
});
