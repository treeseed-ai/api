import { expect, it, vi } from 'vitest';
import { proposalNativeFixture } from '../../../../governance/proposals/architecture/proposal-native-fixture.ts';
import { readyProposal } from '../../../../governance/proposals/architecture/ready-proposal-fixture.ts';
import { workItemContext } from '../../../../../../../src/api/capacity/services/build/ready-execution-node.ts';
import { buildAssignmentAttempt } from '../../../../../../../src/api/capacity/services/capacity/assignments/planning/execution/assignment-attempt-builder.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../../../src/api/knowledge/gateway-treedx-connection.ts';
import { canonicalOfferBuildInput } from '../../fixtures/assignment-attempt-fixtures.ts';

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
		const profile = { schemaVersion: 'treeseed.agent/v1', id: 'configured/maintenance', name: 'Configured maintenance',
			agentClass: 'customer-maintenance', purpose: 'Document the accepted recovery contract.', responsibilities: ['Document recovery.'],
			capabilities: ['documentation-change'], context: { include: ['assignment-subject'] }, activityProfiles: {
				estimating: { handler: 'estimate', permissions: { content: { read: ['agent', 'proposal'], write: ['proposal'] }, tools: ['source.read'] }, prompt: { system: 'Estimate your own future contribution.' } },
				acting: { handler: 'actor', permissions: { content: { read: ['proposal'], write: [] }, tools: ['source.read', 'source.write'] }, prompt: { system: 'Write the accepted Git documentation change.' } },
			} };
		const written = f.publishContent('agents/maintenance.mdx', profile);
		const own = { store: 'treedx' as const, model: 'agent', id: profile.id, repository: 'repository',
			commit: written.commit, path: 'agents/maintenance.mdx' };
		const input = canonicalOfferBuildInput(), exact = structuredClone(input.candidate);
		exact.node.kind = 'estimating'; exact.node.pairRole = null; delete exact.node.workItemId; exact.node.workspace = 'treedx';
		exact.node.sourceRef = sourceRef; exact.node.requestedPermissions = profile.activityProfiles.estimating.permissions as never;
		exact.effectiveProfile.activity = 'estimating'; exact.effectiveProfile.permissionCeiling = exact.node.requestedPermissions;
		exact.effectiveProfile.profileRef = own; exact.contextRefs = [sourceRef]; exact.projectContentRepositoryId = 'repository';
		const heldInput = structuredClone(exact), issued = buildAssignmentAttempt({ ...input, candidate: exact }).assignment;
		expect(issued.contextRefs).toContainEqual(own); expect(issued.grant.contentRead).toContainEqual(own);
		expect(issued.grant.sourceWrite).toEqual([]); expect(issued.grant.tools).toEqual(['source.read']);
		const connection = await resolveKnowledgeGatewayConnection(f.store, { projectId: 'project', write: false, relationPaths: true, readRefs: [own.commit] });
		expect(connection).not.toBeNull();
		const observed = await connection!.client.readRepositoryFile({ repoId: own.repository, ref: own.commit, path: own.path, encoding: 'utf8', parseFrontmatter: true, allowProtected: true }) as { resolvedRef: string; file: { content: string; frontmatter: unknown } };
		expect(observed.resolvedRef).toBe(own.commit); expect(observed.file.content).toBe(written.source); expect(observed.file.frontmatter).toEqual(profile);
		expect(exact).toEqual(heldInput);
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
