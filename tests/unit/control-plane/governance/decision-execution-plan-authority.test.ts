import { describe, expect, it, vi } from 'vitest';
import { validateDecisionAuthority, type DecisionAuthorityDatabase } from '../../../../src/api/governance/decision-authority.ts';
import { evaluateGovernanceProposalMethod } from '../../../../src/api/store/governance/policy/contracts/evaluate-governance-proposal.ts';
import type { ControlPlaneStore } from '../../../../src/api/persistence/store.ts';

const digest = 'b'.repeat(64);
const baseRow = {
	id: 'decision', team_id: 'team', project_id: 'project', proposal_id: 'proposal', proposal_version: 2,
	proposal_content_hash: digest, status: 'accepted', superseded_at: null,
	proposal_status: 'accepted', active_version: 2, active_content_hash: digest,
};

// Single-row UNIT collaborator, not owning SQL integration. Preserve the
// database's generic query signature; callers choose their projected row type.
function decisionDatabase(row: Record<string, unknown>): DecisionAuthorityDatabase {
	return { first: async <T extends Record<string, unknown> = Record<string, unknown>>(): Promise<T | null> => structuredClone(row) as T };
}

describe('decision proposal authority', () => {
	it('requires immutable proposal provenance on every accepted decision', async () => {
		const database = decisionDatabase({ ...baseRow, decision_record_json: { decisionDependencies: [] } });
		await expect(validateDecisionAuthority(database, 'decision')).resolves.toMatchObject({
			valid: false, code: 'governance_decision_proposal_ref_invalid',
		});
	});

	it('denies an operational proposal snapshot without governed classed Decision authority', async () => {
		const proposalRef = { store: 'treedx', model: 'proposal', id: 'proposal', revision: 2, digest: `sha256:${digest}`, repository: 'repository', commit: 'a'.repeat(40), path: 'proposals/proposal.mdx' };
		const database = decisionDatabase({ ...baseRow, decision_record_json: { decisionDependencies: [], proposalRef } });
		await expect(validateDecisionAuthority(database, 'decision')).resolves.toMatchObject({
			valid: false,
		});
	});
});

describe('accepted proposal decision recovery', () => {
	it('retries idempotent decision creation after an interrupted acceptance', async () => {
		const proposal = { id: 'proposal', status: 'accepted', activeVersion: 2, decisionId: null };
		const create = vi.fn(async () => ({ id: 'decision' }));
		const store = {
			ensureInitialized: vi.fn(), getGovernanceProposal: vi.fn()
				.mockResolvedValueOnce(proposal).mockResolvedValueOnce({ ...proposal, decisionId: 'decision' }),
			latestGovernanceElectorateSnapshot: vi.fn(async () => ({ id: 'electorate' })),
			createGovernanceDecisionFromProposal: create,
		};
		await expect(evaluateGovernanceProposalMethod.call(store as unknown as ControlPlaneStore, 'proposal', {
			expectedProposalVersion: 2, actorType: 'user', actorId: 'admin',
		})).resolves.toMatchObject({ decisionId: 'decision' });
		expect(create).toHaveBeenCalledWith('proposal', expect.objectContaining({ electorateSnapshotId: 'electorate', actorId: 'admin' }));
	});
});
