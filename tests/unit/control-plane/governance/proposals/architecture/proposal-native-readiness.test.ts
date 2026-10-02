import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadTeamExecutableProposalSources } from '../../../../../../src/api/capacity/services/capacity/execution/executable-proposal-source.ts';
import { readExactProposal } from '../../../../../../src/api/governance/executable-proposal.ts';
import { proposalNativeFixture } from './proposal-native-fixture.ts';
import { readyProposal, readyWorkItem } from './ready-proposal-fixture.ts';

afterEach(() => vi.unstubAllEnvs());
function isolatedEnvironment() {
	vi.stubEnv('TREESEED_TREEDX_URL', ''); vi.stubEnv('TREESEED_TREEDX_BASE_URL', '');
	vi.stubEnv('TREESEED_ENVIRONMENT', 'test');
}
describe('architecture readiness native SQL and public HTTP-client integration', () => {
	it('admits canonical optional-capability omission instead of imposing a second proposal schema', async () => {
		isolatedEnvironment(); const native = await proposalNativeFixture();
		try {
			const definition = readyProposal();
			delete (definition.executionPlan.workItems[0] as Record<string, unknown>).requiredCapabilities;
			await native.publish(definition); const before = await native.snapshot();
			expect(await loadTeamExecutableProposalSources(native.store, 'team', 'project')).toHaveLength(1);
			expect(await native.snapshot()).toEqual(before);
		} finally { await native.close(); }
	});
	it('replays complete native proposal source without rewriting content estimates or SQL authority', async () => {
		isolatedEnvironment(); const native = await proposalNativeFixture();
		try {
			const definition = readyProposal(), before = structuredClone(definition);
			const exact = await native.publish(definition), snapshot = await native.snapshot();
			const stored = (await native.query('SELECT * FROM governance_proposals')).rows[0]!;
			await expect(readExactProposal(native.store, stored)).resolves.toMatchObject({ source: exact.source });
			const first = await loadTeamExecutableProposalSources(native.store, 'team', 'project');
			expect(first).toHaveLength(1);
			expect(first[0]).toMatchObject({ commit: exact.commit, digest: `sha256:${exact.digest}`, frontmatter: definition });
			expect(await loadTeamExecutableProposalSources(native.store, 'team', 'project')).toEqual(first);
			expect(await Promise.all([loadTeamExecutableProposalSources(native.store, 'team', 'project'),
				loadTeamExecutableProposalSources(native.store, 'team', 'project')])).toEqual([first, first]);
			expect(await native.snapshot()).toEqual(snapshot); expect(definition).toEqual(before);
			expect(native.requests).toEqual(Array.from({ length: 5 }, () => ({ ref: exact.commit, path: 'proposals/proposal.mdx' })));
		} finally { await native.close(); }
	});
	it('denies duplicate dangling and cyclic governed work at the actual SQL source boundary', async () => {
		isolatedEnvironment(); const native = await proposalNativeFixture();
		try {
			const item = readyWorkItem(), other = { ...readyWorkItem(), id: 'other-work' };
			const graphs = [[item, item], [{ ...item, dependsOn: ['missing'] }],
				[{ ...item, dependsOn: ['other-work'] }, { ...other, dependsOn: [item.id] }]];
			const admitted: number[] = [];
			for (const [index, workItems] of graphs.entries()) {
				await native.publish({ ...readyProposal(), executionPlan: { workItems } });
				const before = await native.snapshot();
				if ((await loadTeamExecutableProposalSources(native.store, 'team', 'project')).length) admitted.push(index);
				expect(await native.snapshot()).toEqual(before);
			}
			expect(admitted).toEqual([]);
		} finally { await native.close(); }
	});
	it('keeps denied moved and digest-mismatched exact HTTP reads closed without mutating persisted source', async () => {
		isolatedEnvironment(); const native = await proposalNativeFixture();
		try {
			await native.publish(readyProposal());
			const proposal = (await native.query('SELECT * FROM governance_proposals')).rows[0]!;
			const before = await native.snapshot();
			for (const fault of ['denied', 'moved'] as const) {
				native.setFault(fault); await expect(readExactProposal(native.store, proposal)).rejects.toThrow();
			}
			native.setFault('none');
			await expect(readExactProposal(native.store, { ...proposal, active_content_hash: 'f'.repeat(64) })).rejects
				.toMatchObject({ code: 'proposal_digest_mismatch' });
			expect(await native.snapshot()).toEqual(before);
		} finally { await native.close(); }
	});
});
