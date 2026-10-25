import { expect, it, vi } from 'vitest';

const exactProposal = vi.hoisted(() => vi.fn());
vi.mock('../../../../../../../src/api/capacity/services/capacity/execution/proposal-contributions.ts', () => ({
	loadProposalGroupContributions: async (_store: unknown, proposal: { id: string }) => ({
		current: proposal.id !== 'retained', missing: proposal.id === 'retained' ? ['project/project/new-subscriber'] : [],
		attempts: [], profiles: {}, independent: true,
	}),
}));
vi.mock('../../../../../../../src/api/governance/executable-proposal.ts', async importOriginal => ({
	...await importOriginal<typeof import('../../../../../../../src/api/governance/executable-proposal.ts')>(),
	readExactProposal: exactProposal,
}));
import { loadTeamExecutableProposalSources } from '../../../../../../../src/api/capacity/services/capacity/execution/executable-proposal-source.ts';
import { readyContributionProposal } from '../../../../governance/proposals/architecture/ready-proposal-fixture.ts';

it.each(['inactive', 'active', 'unmaterialized', 'no-callback'])('isolates retained contribution drift without weakening issued or unmaterialized authority: %s', async mode => {
	const ref = { id: 'retained', repository: 'library', commit: 'b'.repeat(40),
		path: 'proposals/retained.mdx', digest: `sha256:${'a'.repeat(64)}` };
	const retained = { proposal_id: 'retained', project_id: 'project', active_version: 1,
		active_content_hash: 'a'.repeat(64), accepted_decision_id: 'decision', proposal_version: 1,
		decision_record_json: { proposalRef: ref } };
	const healthy = { proposal_id: 'healthy', project_id: 'other-project', active_version: 1,
		active_content_hash: 'c'.repeat(64), accepted_decision_id: null };
	const graph = mode === 'unmaterialized' ? [] : [{ id: 'retained-node',
		source_ref_json: { model: 'proposal', id: 'retained', digest: ref.digest }, status: 'blocked' }];
	const held = structuredClone({ retained, healthy, graph });
	const store = { all: vi.fn(async (sql: string) => {
		if (sql.includes('FROM governance_proposals')) return [retained, healthy];
		if (sql.includes('FROM execution_nodes')) return graph;
		if (sql.includes('FROM capacity_provider_assignments')) return mode === 'active' ? [{ execution_node_id: 'retained-node' }] : [];
		return [];
	}) };
	exactProposal.mockImplementation(async (_store, row) => ({
		ref: row.proposal_id === 'retained' ? ref : { ...ref, id: 'healthy', digest: `sha256:${'c'.repeat(64)}` },
		definition: { ...readyContributionProposal(), id: row.proposal_id,
			status: row.proposal_id === 'retained' ? 'decided' : 'ready' },
	}));
	const frozen: unknown[] = [];
	const outcome = loadTeamExecutableProposalSources(store, 'team', undefined,
		mode === 'no-callback' ? undefined : source => frozen.push(source));
	if (mode === 'inactive') {
		await expect(outcome).resolves.toMatchObject([{ projectId: 'other-project', frontmatter: { id: 'healthy' } }]);
		expect(frozen).toEqual([{ id: ref.id, digest: ref.digest }]);
	} else {
		await expect(outcome).rejects.toMatchObject({ code: 'proposal_contributions_unverified',
			details: { missing: ['project/project/new-subscriber'] } });
		expect(frozen).toEqual([]);
	}
	expect({ retained, healthy, graph }).toEqual(held);
});
