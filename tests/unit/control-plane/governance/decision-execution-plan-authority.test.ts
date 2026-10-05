import { describe, expect, it, vi } from 'vitest';
import { validateDecisionAuthority, type DecisionAuthorityDatabase } from '../../../../src/api/governance/decision-authority.ts';
import { evaluateGovernanceProposalMethod } from '../../../../src/api/store/governance/policy/contracts/evaluate-governance-proposal.ts';
import { ControlPlaneStore } from '../../../../src/api/persistence/store.ts';

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
	it('decision creation replay rejects retained foreign stale rejected and superseded authority before returning or rewriting an existing decision', async () => {
		const proposal = { id: 'proposal', team_id: 'team', project_id: 'project', status: 'accepted', active_version: 2,
			active_content_hash: digest, proposal_types_json: '["implementation"]', metadata_json: '{}', decision_id: 'decision' };
		const decision = { ...baseRow, decision_record_json: JSON.stringify({ decisionDependencies: [], proposalRef: {
			store: 'treedx', model: 'proposal', id: 'proposal', revision: 2, digest: `sha256:${digest}`,
			repository: 'repository', commit: 'a'.repeat(40), path: 'proposals/proposal.mdx' } }) };
		const variants = [
			{ proposal, decision: { ...decision, team_id: 'foreign-team' }, code: 'governance_decision_team_mismatch' },
			{ proposal, decision: { ...decision, project_id: 'foreign-project' }, code: 'governance_decision_project_mismatch' },
			{ proposal, decision: { ...decision, status: 'rejected' }, code: 'governance_decision_not_accepted' },
			{ proposal, decision: { ...decision, superseded_at: '2026-10-04T00:00:00.000Z' }, code: 'governance_decision_not_accepted' },
			{ proposal: { ...proposal, status: 'withdrawn' }, decision, code: 'governance_proposal_not_accepted' },
			{ proposal: { ...proposal, active_version: 3 }, decision, code: 'governance_decision_proposal_stale' },
			{ proposal: { ...proposal, active_content_hash: 'c'.repeat(64) }, decision, code: 'governance_decision_proposal_stale' },
		];
		for (const variant of variants) {
			const input = { actorType: 'user', actorId: 'operator' }, before = structuredClone({ variant, input });
			const reads: string[] = [], writes: string[] = [];
			const store = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, {
				prepare: (sql: string) => ({ bind: (..._params: unknown[]) => ({
					first: async () => { reads.push(sql);
						if (sql.includes('FROM governance_proposals')) return variant.proposal;
						if (sql.includes('LEFT JOIN governance_proposals')) return { ...variant.decision,
							proposal_status: variant.proposal.status, active_version: variant.proposal.active_version,
							active_content_hash: variant.proposal.active_content_hash };
						if (sql.includes('FROM governance_decisions')) return variant.decision;
						throw new Error('Unexpected decision-replay UNIT read'); },
					all: async () => { throw new Error('Unexpected decision-replay UNIT inventory read'); },
					run: async () => { writes.push(sql); throw new Error('Unexpected decision-replay UNIT write'); },
				}) }),
				batch: async () => { writes.push('batch'); throw new Error('Unexpected decision-replay UNIT batch'); },
			});
			store.initializationPromise = Promise.resolve();
			for (let retry = 0; retry < 2; retry++) await expect(store.createGovernanceDecisionFromProposal('proposal', input))
				.rejects.toMatchObject({ status: 409, code: variant.code });
			expect(reads.length).toBeGreaterThan(0); expect(writes).toEqual([]);
			expect({ variant, input }).toEqual(before);
		}
	});
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
