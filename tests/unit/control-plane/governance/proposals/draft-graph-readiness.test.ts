import { describe, expect, it, vi } from 'vitest';
import { ControlPlaneStore, serializeGovernanceProposal } from '../../../../../src/api/persistence/store.ts';
import * as executableProposal from '../../../../../src/api/governance/executable-proposal.ts';
const proposalRef = { store: 'treedx' as const, model: 'proposal', id: 'proposal', revision: 1,
	digest: `sha256:${'a'.repeat(64)}`, repository: 'library', commit: 'b'.repeat(40), path: 'proposals/proposal.mdx' };

vi.mock('../../../../../src/api/governance/executable-proposal.ts', async (importOriginal) => {
	const original = await importOriginal<typeof import('../../../../../src/api/governance/executable-proposal.ts')>();
	const { readyProposal } = await import('./architecture/ready-proposal-fixture.ts');
	return { ...original, readExactProposal: vi.fn(async () => ({ definition: readyProposal(), source: 'Controlled UNIT proposal',
		ref: { store: 'treedx', model: 'proposal', id: 'proposal', revision: 1, digest: `sha256:${'a'.repeat(64)}`,
			repository: 'library', commit: 'b'.repeat(40), path: 'proposals/proposal.mdx' } })) };
});
vi.mock('../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts',
	() => ({ reconcileExecutionGraph: vi.fn(async () => undefined) }));

import { governanceProposalReadinessMethod } from '../../../../../src/api/store/governance/policy/contracts/governance-proposal-readiness.ts';

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
		// Supplied UNIT rows/readbacks, not native governance or SQL proof.
		const proposal = serializeGovernanceProposal({ id: 'proposal', team_id: 'team', project_id: 'project', status: 'accepted',
			active_version: 1, active_content_hash: 'a'.repeat(64), metadata_json: '{}', governance_provider_id: 'default' });
		const row: Record<string, unknown> = { id: 'decision', team_id: 'team', project_id: 'project', proposal_id: 'proposal',
			proposal_version: 1, proposal_content_hash: 'a'.repeat(64), status: 'creating', superseded_at: null,
			created_at: '2026-10-04T00:00:00.000Z', proposal_status: 'accepted', active_version: 1, active_content_hash: 'a'.repeat(64),
			decision_record_json: JSON.stringify({ proposalRef, decisionDependencies: [] }) };
		const store = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, { prepare: () => {
			throw new Error('Unexpected native SQL in UNIT collaborator');
		} });
		store.initializationPromise = Promise.resolve();
		let reserved = false;
		const run = vi.spyOn(store, 'run').mockImplementation(async (sql, params) => {
			expect(sql).toContain('INSERT INTO governance_decisions');
			row.id = params![0]; reserved = true;
		});
		const first = vi.spyOn(store, 'first').mockImplementation(async <T extends Record<string, unknown>>() => reserved ? structuredClone(row) as T : null);
		const getProposal = vi.spyOn(store, 'getGovernanceProposal').mockResolvedValue(proposal);
		// Preserve this UNIT's original projected result collaborator. The full
		// native Decision result/readback is covered in proposal-decision-native.
		const getDecision = vi.fn(async () => ({ id: 'decision' }));
		Object.assign(store, { getGovernanceDecision: getDecision });
		const votes = vi.spyOn(store, 'effectiveGovernanceVotes').mockResolvedValue([]);
		const decisionRef = { ...proposalRef, model: 'decision', id: 'decision', path: 'decisions/decision.mdx' };
		const publish = vi.spyOn(executableProposal, 'publishProposalDecision').mockResolvedValue(decisionRef);
		const read = vi.spyOn(executableProposal, 'readExactDecision').mockResolvedValue({ source: 'Controlled UNIT Decision', ref: decisionRef,
			definition: { schemaVersion: 'treeseed.decision/v1', id: 'decision', projectId: 'project', decisionClass: 'proposal',
				decisionMethod: 'authority', subjectRef: proposalRef, disposition: 'approved', rationale: 'Controlled UNIT authority',
				authorityRefs: [{ store: 'postgresql', model: 'user', id: 'operator' }],
				decidedByRefs: [{ store: 'postgresql', model: 'user', id: 'operator' }], decidedAt: '2026-10-04T00:00:00.000Z' } });
		const batch = vi.spyOn(store, 'batch').mockImplementation(async operations => {
			expect(operations).toHaveLength(3);
			row.status = 'accepted'; row.decision_record_json = JSON.stringify({ proposalRef, decisionDependencies: [], decisionRef });
		});
		try {
			await expect(store.createGovernanceDecisionFromProposal(proposal.id)).resolves.toEqual({ id: 'decision' });
			expect(publish).toHaveBeenCalledWith(store, proposal, expect.objectContaining({ id: row.id, status: 'creating' }), []);
			expect(batch).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledOnce();
			expect(run).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO governance_decisions'), expect.any(Array));
		} finally { run.mockRestore(); first.mockRestore(); getProposal.mockRestore();
			votes.mockRestore(); publish.mockRestore(); read.mockRestore(); batch.mockRestore(); }
	});
});
