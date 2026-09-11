import { describe, expect, it, vi } from 'vitest';
import { governanceContentHash, type ControlPlaneStore } from '../../../../src/api/persistence/store.ts';
import { updateGovernanceProposalDraftMethod } from '../../../../src/api/store/governance/policy/updates/update-governance-proposal-draft.ts';

function fixture(provenance: Record<string, string> | null = null) {
	const metadata = { proposalTypes: ['implementation'], relatedObjectives: [], evidenceRefs: [], decisionDependencies: [], contentProvenance: provenance };
	const proposal = { id: 'proposal-1', projectId: 'project-1', teamId: 'team-1', status: 'draft', activeVersion: 1,
		title: 'Existing draft', summary: 'Existing summary', body: 'Existing body', proposalType: 'implementation',
		proposalTypes: ['implementation'], metadata, activeContentHash: '' };
	proposal.activeContentHash = governanceContentHash({ ...proposal, ...metadata });
	const store = { ensureInitialized: vi.fn(async () => undefined), getGovernanceProposal: vi.fn(async () => proposal),
		run: vi.fn(async () => undefined), first: vi.fn(async () => ({ id: 'existing-event' })), batch: vi.fn(async () => undefined),
		recordGovernanceEvent: vi.fn(async () => undefined) };
	const update = (input: Record<string, unknown> = {}) => updateGovernanceProposalDraftMethod.call(store as unknown as ControlPlaneStore,
		{ id: 'user-1' }, proposal.id, { expectedProposalVersion: 1, changeReason: 'Publish the draft.', ...input });
	return { store, proposal, update };
}

describe('proposal publication provenance', () => {
	it.each([null, {}, { contentPath: 'proposals/test.md', commitSha: 'a'.repeat(40), digest: ' ' }])(
		'forces TreeDX authoring instead of replaying unpublished content (%j)', async (provenance) => {
			const { store, update } = fixture(provenance);
			await expect(update({ repairExistingVersion: true })).rejects.toMatchObject({ code: 'governance_proposal_repair_material_change' });
			expect(store.run).not.toHaveBeenCalled();
			expect(store.batch).not.toHaveBeenCalled();
			expect(store.recordGovernanceEvent).not.toHaveBeenCalled();
		});

	it('does not publish provenance-free evidence through the normal writer', async () => {
		const { store, update } = fixture();
		await expect(update()).rejects.toMatchObject({ code: 'governance_proposal_provenance_required' });
		expect(store.run).not.toHaveBeenCalled();
	});

	it('retains idempotent replay for an already authored version', async () => {
		const { proposal, store, update } = fixture({ contentPath: 'proposals/test.md', commitSha: 'a'.repeat(40), digest: 'b'.repeat(64) });
		expect(await update({ repairExistingVersion: true })).toBe(proposal);
		expect(store.run).toHaveBeenCalledOnce();
		expect(store.batch).not.toHaveBeenCalled();
	});

	it('rejects stale concurrency before attempting publication', async () => {
		const { store, update } = fixture();
		await expect(update({ expectedProposalVersion: 2, repairExistingVersion: true })).rejects.toMatchObject({ code: 'governance_proposal_version_stale' });
		expect(store.run).not.toHaveBeenCalled();
	});
});
