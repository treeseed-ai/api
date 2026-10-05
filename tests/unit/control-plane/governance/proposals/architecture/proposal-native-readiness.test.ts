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
	it('real exact proposal intake refuses ready or decided missing summary plan or independent estimates without repairing indexed source bytes before unchanged ready retry', async () => {
		isolatedEnvironment(); const native = await proposalNativeFixture();
		try {
			const definition = { ...readyProposal(), status: 'ready' }, item = definition.executionPlan.workItems[0]!;
			await native.publish(definition);
			const changes = [{ summary: undefined }, { executionPlan: undefined },
				{ executionPlan: { workItems: [{ ...item, estimate: undefined }] } },
				{ executionPlan: { workItems: [{ ...item, reviewEstimate: undefined }] } }];
			const inputs = ['ready', 'decided'].flatMap(status => changes.map(change => ({ ...definition, status, ...change })));
			const held = structuredClone(inputs), denied: Record<string, unknown>[] = [];
			const index = async (exact: ReturnType<typeof native.publishContent>) => {
				await native.query('UPDATE governance_proposals SET active_version=active_version+1,active_content_hash=?,metadata_json=? WHERE id=?',
					[exact.digest, JSON.stringify({ contentProvenance: { repositoryId: 'repository', contentPath: 'proposals/proposal.mdx',
						commitSha: exact.commit, digest: exact.digest } }), 'proposal']);
				return (await native.query('SELECT * FROM governance_proposals')).rows[0]!;
			};
			for (const input of inputs) {
				const exact = native.publishContent('proposals/proposal.mdx', input), row = await index(exact), before = await native.snapshot();
				for (let retry = 0; retry < 2; retry++) {
					await expect(readExactProposal(native.store, row)).rejects.toMatchObject({ status: 422, code: 'proposal_execution_plan_invalid' });
					expect(await loadTeamExecutableProposalSources(native.store, 'team', 'project')).toEqual([]);
					expect(await native.snapshot()).toEqual(before);
				}
				denied.push(row);
			}
			const exact = native.publishContent('proposals/proposal.mdx', definition), row = await index(exact), before = await native.snapshot();
			await expect(readExactProposal(native.store, row)).resolves.toMatchObject({ source: exact.source, definition });
			const sources = await loadTeamExecutableProposalSources(native.store, 'team', 'project'); expect(sources).toHaveLength(1);
			expect(sources[0]).toMatchObject({ frontmatter: definition, commit: exact.commit, digest: `sha256:${exact.digest}`, decision: null });
			expect(await Promise.all([loadTeamExecutableProposalSources(native.store, 'team', 'project'),
				loadTeamExecutableProposalSources(native.store, 'team', 'project')])).toEqual([sources, sources]);
			for (const row of denied) await expect(readExactProposal(native.store, row)).rejects.toMatchObject({ status: 422, code: 'proposal_execution_plan_invalid' });
			expect(await native.snapshot()).toEqual(before); expect(inputs).toEqual(held);
			// Committed source and native SQL index are controlled inputs, not an
			// accepted Decision, native governance transition or provider dispatch.
		} finally { await native.close(); }
	});
	it('real executable proposal intake retains invalid committed work-item inventories through repeated denial before exact bounded source retry', async () => {
		isolatedEnvironment(); const native = await proposalNativeFixture();
		try {
			const definition = readyProposal(), item = definition.executionPlan.workItems[0]!;
			const ref = { store: 'git', model: 'repository', id: 'source', repository: 'treeseed-ai/source', commit: 'a'.repeat(40) };
			const bounded = { ...item, id: 'a'.repeat(100), agentClass: 'a'.repeat(100),
				requiredCapabilities: ['source.read', 'a'.repeat(200)], contextRefs: [ref] };
			const variants = [{ id: 'a'.repeat(101) }, { agentClass: 'a'.repeat(101) },
				{ requiredCapabilities: ['source.read', 'source.read'] }, { requiredCapabilities: ['source.read', 'internal space'] },
				{ contextRefs: [ref, Object.fromEntries(Object.entries(ref).reverse())] },
				{ requestedPermissions: { ...item.requestedPermissions, content: { read: ['proposal', 'proposal'], write: [] } } },
				{ requestedPermissions: { ...item.requestedPermissions, content: { read: ['proposal'], write: ['note', 'note'] } } },
				{ requestedPermissions: { ...item.requestedPermissions, tools: ['source.read', 'source.read'] } }];
			const inputs = variants.map(patch => ({ ...definition, executionPlan: { workItems: [{ ...bounded, ...patch }] } }));
			const held = structuredClone(inputs), denied: Array<{ row: Record<string, unknown>; source: string }> = [];
			for (const input of inputs) {
				const exact = await native.publish(input), row = (await native.query('SELECT * FROM governance_proposals')).rows[0]!;
				const before = await native.snapshot();
				for (let retry = 0; retry < 2; retry++) {
					await expect(readExactProposal(native.store, row)).rejects.toMatchObject({ status: 422, code: 'proposal_execution_plan_invalid' });
					expect(await loadTeamExecutableProposalSources(native.store, 'team', 'project')).toEqual([]);
					expect(await native.snapshot()).toEqual(before);
				}
				denied.push({ row, source: exact.source });
			}
			const valid = { ...definition, executionPlan: { workItems: [bounded] } }, original = structuredClone(valid);
			const exact = await native.publish(valid), before = await native.snapshot();
			const row = (await native.query('SELECT * FROM governance_proposals')).rows[0]!;
			await expect(readExactProposal(native.store, row)).resolves.toMatchObject({ source: exact.source });
			const first = await loadTeamExecutableProposalSources(native.store, 'team', 'project');
			expect(first).toHaveLength(1); expect(first[0]).toMatchObject({ frontmatter: valid, commit: exact.commit, digest: `sha256:${exact.digest}` });
			expect(await Promise.all([loadTeamExecutableProposalSources(native.store, 'team', 'project'),
				loadTeamExecutableProposalSources(native.store, 'team', 'project')])).toEqual([first, first]);
			for (const observation of denied) {
				await expect(readExactProposal(native.store, observation.row)).rejects.toMatchObject({ status: 422, code: 'proposal_execution_plan_invalid' });
			}
			expect(await native.snapshot()).toEqual(before); expect(inputs).toEqual(held); expect(valid).toEqual(original);
		} finally { await native.close(); }
	});
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
				[{ ...item, dependsOn: ['other-work'] }, { ...other, dependsOn: [item.id] }],
				[{ ...item, dependsOn: ['other-work', 'other-work'] }, other]];
			const admitted: number[] = [];
			for (const [index, workItems] of graphs.entries()) {
				await native.publish({ ...readyProposal(), executionPlan: { workItems } });
				const before = await native.snapshot();
				if ((await loadTeamExecutableProposalSources(native.store, 'team', 'project')).length) admitted.push(index);
				expect(await native.snapshot()).toEqual(before);
			}
			expect(admitted).toEqual([]);
			const restored = { ...readyProposal(), executionPlan: { workItems: [{ ...item, dependsOn: ['other-work'] }, other] } };
			await native.publish(restored); const before = await native.snapshot(), supplied = structuredClone(restored);
			expect(await loadTeamExecutableProposalSources(native.store, 'team', 'project')).toHaveLength(1);
			expect(await native.snapshot()).toEqual(before); expect(restored).toEqual(supplied);
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
