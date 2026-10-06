import { describe, expect, it, vi } from 'vitest';
import { createGovernanceProposalMethod } from '../../../../src/api/store/governance/policy/creation/create-governance-proposal.ts';

describe('governance proposal creation defaults', () => {
	it('uses the implementation contract when the portable proposal omits an optional type', async () => {
		const writes: Array<{ sql: string; params: unknown[] }> = [];
		const store = {
			ensureInitialized: vi.fn(async () => undefined),
			getProject: vi.fn(async () => ({ id: 'project-1', teamId: 'team-1' })),
			resolveGovernancePolicy: vi.fn(async () => null),
			run: vi.fn(async (sql: string, params: unknown[]) => { writes.push({ sql, params }); }),
			recordGovernanceEvent: vi.fn(async () => undefined),
			getGovernanceProposal: vi.fn(async () => ({ id: 'proposal-1', proposalType: 'implementation', proposalTypes: ['implementation'] })),
		};

		const result = await createGovernanceProposalMethod.call(store as never, { id: 'user-1' }, {
			id: 'proposal-1', projectId: 'project-1', request: 'Verify the portable proposal.', title: 'Portable proposal',
		});

		expect(result).toMatchObject({ proposalType: 'implementation', proposalTypes: ['implementation'] });
		expect(writes[0]?.params).toContain('implementation');
		expect(writes[0]?.params).not.toContain('undefined');
	});
});
