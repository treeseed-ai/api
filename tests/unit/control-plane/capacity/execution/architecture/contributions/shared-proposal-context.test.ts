import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { expect, it, vi } from 'vitest';
const gateway = vi.hoisted(() => ({ readRepositoryFile: vi.fn() }));
vi.mock('../../../../../../../src/api/knowledge/gateway-treedx-connection.ts', () => ({
 resolveKnowledgeGatewayConnection: vi.fn(async () => ({ repositoryId: 'repository', client: gateway })),
}));
import { resolveKnowledgeGatewayConnection } from '../../../../../../../src/api/knowledge/gateway-treedx-connection.ts';
import { workItemContext } from '../../../../../../../src/api/capacity/services/build/ready-execution-node.ts';
import { readyContributionProposal, readyProposal } from '../../../../governance/proposals/architecture/ready-proposal-fixture.ts';
import { buildAssignmentAttempt } from '../../../../../../../src/api/capacity/services/capacity/assignments/planning/execution/assignment-attempt-builder.ts';
import { canonicalOfferBuildInput, candidate, gitRef, permissions as grantedPermissions, sourceRef as assignmentSource } from '../../fixtures/assignment-attempt-fixtures.ts';
const sourceRef = { store: 'treedx', model: 'proposal', id: 'proposal', revision: 1,
 digest: `sha256:${'a'.repeat(64)}`, repository: 'repository', commit: 'b'.repeat(40), path: 'proposals/one.mdx' };
const permissions = { content: { read: ['proposal', 'decision'], write: [] }, tools: ['source.read'] };
it('retains shared exact proposal context for acting and reviewing without importing peer workspace references', async () => {
	const proposal = readyContributionProposal(), item = proposal.executionPlan.workItems[0]!;
	const own = { store: 'git', model: 'repository', id: 'selected-source', repository: 'treeseed-ai/project', commit: 'c'.repeat(40) };
	const evidence = { ...own, id: 'historical-source', commit: 'd'.repeat(40) };
	const objective = { store: 'treedx', model: 'objective', id: 'related', repository: 'repository', commit: 'e'.repeat(40), path: 'objectives/related.mdx' };
	const discussion = { ...objective, model: 'discussion-message', id: 'planning', path: 'discussion-messages/plan/one.mdx' };
	const peer = { ...own, id: 'peer-source', repository: 'treeseed-ai/peer', commit: 'f'.repeat(40) };
	Object.assign(proposal, { objectiveRefs: [objective], evidenceRefs: [evidence], discussionRef: discussion,
		executionPlan: { workItems: [{ ...item, contextRefs: [own] }, { ...item, id: 'peer-item', contextRefs: [peer] }] } });
	const content = `---\n${stringify(proposal)}---\n`, exact = { ...sourceRef,
		digest: `sha256:${createHash('sha256').update(content).digest('hex')}` };
	gateway.readRepositoryFile.mockResolvedValue({ resolvedRef: exact.commit, file: { content, frontmatter: proposal } });
	const store = { getGovernanceProposal: async () => ({ id: 'proposal', projectId: 'project', teamId: 'team' }),
		getProjectTreeDxLibrary: async () => ({ repositoryId: 'repository' }) };
	const held = structuredClone(proposal);
	for (const kind of ['acting', 'reviewing']) {
		const node = { id: `${kind}-selected`, kind, workItemId: item.id, sourceRef: exact, teamId: 'team', projectId: 'project' };
		const before = structuredClone(node), refs = await workItemContext(store, node as never);
		expect(refs).toEqual([own, objective, evidence, discussion]);
		expect(refs).not.toContainEqual(peer);
		// The selected item's current source remains ahead of historical evidence.
		expect(refs.find(ref => ref.store === 'git')?.commit).toBe(own.commit);
		expect(node).toEqual(before);
	}
	expect(proposal).toEqual(held);
});
it('includes exact accepted scope for Git-only work without general content authority', () => {
	const exact = structuredClone(candidate), decision = { ...assignmentSource, model: 'decision', id: 'accepted', path: 'decisions/accepted.mdx' };
	exact.node.requestedPermissions.content.read = [];
	exact.node.authorityRefs = [decision];
	exact.effectiveProfile.permissionCeiling.content.read = ['proposal', 'decision', 'agent'];
	const input = { ...canonicalOfferBuildInput(), candidate: exact }, held = structuredClone(exact);
	const issued = buildAssignmentAttempt(input).assignment;
	expect(issued.contextRefs).toEqual([gitRef, assignmentSource, exact.effectiveProfile.profileRef, decision]);
	expect(issued.grant.contentRead).toEqual([assignmentSource, exact.effectiveProfile.profileRef, decision]);
	expect(issued.grant.contentWrite).toEqual([]); expect(issued.grant.tools).toEqual(grantedPermissions.tools);
	expect(exact).toEqual(held);
	for (const read of [[], ['proposal'], ['decision']]) {
		exact.effectiveProfile.permissionCeiling.content.read = [...read, 'agent'] as never;
		expect(() => buildAssignmentAttempt(input)).toThrow('Exact assignment scope exceeds its effective activity profile.');
	}
});
// Controlled UNIT content; native SQL/HTTP/Git owner proof is adjacent.
it('reads shared planning proposal context through its owning project binding and refuses a foreign team', async () => {
	for (const kind of ['planning', 'estimating']) for (const teamId of ['team', 'foreign-team']) {
		vi.mocked(resolveKnowledgeGatewayConnection).mockImplementation(async (_store, input) => ({
			repositoryId: input.projectId === 'ui' ? 'repository' : 'admin-library', client: gateway,
		}) as never);
		const proposal = readyContributionProposal(), sharedGit = { store: 'git' as const, model: 'repository', id: 'ui-source', repository: 'treeseed-ai/ui', commit: 'e'.repeat(40) };
		Object.assign(proposal, { id: 'proposal', projectId: 'ui', groupIds: ['portfolio-atlas'] });
		Object.assign(proposal.executionPlan.workItems[0]!, { contextRefs: [sharedGit] });
		const content = `---\n${stringify(proposal)}---\n`, exactRef = { ...sourceRef, digest: `sha256:${createHash('sha256').update(content).digest('hex')}` };
		gateway.readRepositoryFile.mockResolvedValue({ resolvedRef: sourceRef.commit, file: { content, frontmatter: proposal } });
		const fetchImpl = vi.fn(async () => new Response('d'.repeat(40)));
		const store = { getGovernanceProposal: async () => ({ id: 'proposal', projectId: 'ui', teamId }),
			getProjectTreeDxLibrary: async () => ({ repositoryId: 'repository' }), config: { fetchImpl }, all: async () => [],
			listHubRepositories: async () => [{ id: 'admin-source', role: 'software', provider: 'github', owner: 'treeseed-ai', name: 'admin', currentBranch: 'staging' }] };
		const read = workItemContext(store, { id: 'shared-planning', projectId: 'admin', teamId: 'team',
			kind, workItemId: null, sourceRef: exactRef, requestedPermissions: permissions } as never);
		if (teamId === 'team') expect(await read).toEqual([exactRef, sharedGit, { store: 'git', model: 'repository',
			id: 'admin-source', repository: 'treeseed-ai/admin', commit: 'd'.repeat(40) }]);
		else await expect(read).rejects.toMatchObject({ code: 'execution_node_source_invalid' });
	}
	vi.mocked(resolveKnowledgeGatewayConnection).mockImplementation(async () => ({ repositoryId: 'repository', client: gateway }) as never);
});

it('uses the current proposal guard for Workday context without changing legacy bytes or frozen authority', async () => {
	for (const legacy of [true, false]) {
		const proposal = legacy ? readyProposal() : readyContributionProposal();
		const content = `---\n${stringify(proposal)}---\n`, exact = { ...sourceRef,
			digest: `sha256:${createHash('sha256').update(content).digest('hex')}` };
		gateway.readRepositoryFile.mockResolvedValue({ resolvedRef: exact.commit, file: { content, frontmatter: proposal } });
		const book = { ...exact, model: 'book', id: 'core', path: 'books/core.md' };
		const parameters = { workdayContextByProjectId: { project: book }, planningSourceByProposalId: { proposal: exact } };
		const before = structuredClone({ proposal, parameters });
		const store = { first: async () => ({ parameters_json: JSON.stringify(parameters) }),
			getGovernanceProposal: async () => ({ id: 'proposal', teamId: 'team', projectId: 'project' }),
			getProjectTreeDxLibrary: async () => ({ repositoryId: 'repository' }) };
		const read = workItemContext(store, { id: 'workday-planning', teamId: 'team', projectId: 'project',
			kind: 'planning', workdayId: 'run', sourceRef: { store: 'postgresql', model: 'workday', id: 'run' } } as never);
		if (legacy) await expect(read).rejects.toMatchObject({ code: 'execution_node_source_version_unsupported' });
		else expect(await read).toEqual([book, exact]);
		expect({ proposal, parameters }).toEqual(before);
	}
});
