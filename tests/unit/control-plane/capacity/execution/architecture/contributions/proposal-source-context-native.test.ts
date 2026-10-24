import { expect, it, vi } from 'vitest';
import { proposalNativeFixture } from '../../../../governance/proposals/architecture/proposal-native-fixture.ts';
import { readyProposal } from '../../../../governance/proposals/architecture/ready-proposal-fixture.ts';
import { workItemContext } from '../../../../../../../src/api/capacity/services/build/ready-execution-node.ts';

// Committed native Git, original SQL and the official HTTP reader; configured
// nodes are controlled inputs. No model execution or authenticated grant claim.
it('reads acting and reviewing context from the exact shared proposal owner while preserving worker identity and refusing foreign moved or corrupt authority', async () => {
	vi.stubEnv('TREESEED_TREEDX_URL', ''); vi.stubEnv('TREESEED_TREEDX_BASE_URL', ''); vi.stubEnv('TREESEED_ENVIRONMENT', 'test');
	const f = await proposalNativeFixture();
	try {
		const base = readyProposal(), { agentClass: _class, ...item } = base.executionPlan.workItems[0]!;
		const context = { store: 'treedx', model: 'note', id: 'documented-contract', repository: 'repository', commit: 'b'.repeat(40), path: 'notes/contract.mdx' };
		const definition = { ...base, schemaVersion: 'treeseed.proposal/v2', groupIds: ['portfolio-runtime'],
			executionPlan: { workItems: [{ ...item, contextRefs: [context],
				estimateRef: { store: 'postgresql', model: 'assignment-attempt', id: 'controlled-estimate', revision: 1 },
				estimate: { ...item.estimate, rationale: 'Controlled own implementation budget.' },
				reviewEstimate: { ...item.reviewEstimate, rationale: 'Controlled own peer review budget.' } }] } };
		const frozen = await f.publish(definition), sourceRef = { store: 'treedx', model: 'proposal', id: 'proposal', revision: 1,
			repository: 'repository', commit: frozen.commit, path: 'proposals/proposal.mdx', digest: `sha256:${frozen.digest}` };
		const projects: string[] = [], store = { ...f.store,
			getGovernanceProposal: async () => { const row = await f.store.first("SELECT * FROM governance_proposals WHERE id='proposal'");
				return row ? { ...row, teamId: row.team_id, projectId: row.project_id } : null; },
			getProjectTreeDxLibrary: async (id: string) => { projects.push(id); return id === 'project' ? f.store.getProjectTreeDxLibrary() : null; } };
		const before = await f.snapshot();
		for (const kind of ['acting', 'reviewing']) {
			const node = { teamId: 'team', projectId: 'worker', id: `${kind}-contribution`, kind, workItemId: item.id, sourceRef };
			const held = structuredClone(node);
			expect(await workItemContext(store, node as never)).toEqual([context]);
			expect(projects.every(id => id === 'project')).toBe(true); expect(node).toEqual(held); expect(await f.snapshot()).toEqual(before);
			for (const patch of [{ digest: `sha256:${'f'.repeat(64)}` }, { id: 'other-proposal' }])
				await expect(workItemContext(store, { ...node, sourceRef: { ...sourceRef, ...patch } } as never)).rejects.toThrow();
			f.setFault('moved'); await expect(workItemContext(store, node as never)).rejects.toThrow(); f.setFault('none');
			await expect(workItemContext({ ...store, getGovernanceProposal: async () => ({ id: 'proposal', projectId: 'project', teamId: 'foreign' }) }, node as never)).rejects.toThrow();
			expect(node).toEqual(held); expect(await f.snapshot()).toEqual(before);
		}
		const legacy = await f.publish({ ...readyProposal(), groupIds: ['portfolio-runtime'] });
		const retained = await f.snapshot();
		for (const kind of ['acting', 'reviewing']) await expect(workItemContext(store, {
			teamId: 'team', projectId: 'worker', id: `legacy-${kind}`, kind, workItemId: item.id,
			sourceRef: { ...sourceRef, commit: legacy.commit, digest: `sha256:${legacy.digest}` },
		} as never)).rejects.toMatchObject({ code: 'execution_node_source_version_unsupported' });
		expect(await f.snapshot()).toEqual(retained);
	} finally { await f.close(); vi.unstubAllEnvs(); }
});
