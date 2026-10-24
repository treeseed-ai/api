import { expect, it, vi } from 'vitest';
import { agentProfileReference } from '../../../../../src/api/capacity/policy/execution/agent-profile-reference.ts';
import { effectiveProfile } from '../../../../../src/api/capacity/services/build/execution-node-profile.ts';
const gateway = vi.hoisted(() => ({ readRepositoryFile: vi.fn() }));
vi.mock('../../../../../src/api/knowledge/gateway-treedx-connection.ts', () => ({
	resolveKnowledgeGatewayConnection: vi.fn(async () => ({ repositoryId: 'repository', client: gateway })),
}));

it('binds the addressed subscriber among peers sharing a class and rejects missing conflicting or moved identity authority', async () => {
	const definition = (name: string) => ({ schemaVersion: 'treeseed.agent/v1', id: `project/${name}`, name,
		agentClass: 'maintenance', purpose: 'Contribute to portfolio work.', responsibilities: ['Answer the addressed request.'],
		capabilities: ['reasoning'], context: { include: ['project'] }, groupIds: ['portfolio'],
		activityProfiles: { chat: { handler: 'writer', permissions: { content: { read: ['discussion'], write: ['discussion'] }, tools: [] },
			prompt: { system: `Answer as the actual addressed subscriber ${name}.` } } },
	});
	const peer = definition('peer'), selected = definition('target'), commit = 'a'.repeat(40);
	const reference = agentProfileReference(selected as never);
	const source = { id: 'shared-allocation-class', handler_refs_json: { agents: [peer, selected] },
		metadata_json: { source: 'project-library', immutableRef: commit, definitionPaths: ['agents/peer.yaml', 'agents/target.yaml'] } };
	for (const refs of [[reference], [], [reference, agentProfileReference(peer as never)],
		[{ ...reference, digest: `sha256:${'0'.repeat(64)}` }], [{ ...reference, id: 'project/unknown' }]]) {
		const node = { id: 'addressed-request', kind: 'communication', projectId: 'project', agentClass: 'maintenance', authorityRefs: refs };
		const store = { all: vi.fn(async () => [source]) };
		gateway.readRepositoryFile.mockResolvedValue({ resolvedRef: commit, file: { path: 'agents/target.yaml', frontmatter: selected } });
		const pending = effectiveProfile(store, node as never);
		if (refs.length === 1 && refs[0] === reference) {
			const bound = await pending;
			expect(bound.projectAgentClassId).toBe(source.id);
			expect(bound.profile.profileRef.id).toBe(selected.id);
			expect(bound.profile.prompt).toEqual(selected.activityProfiles.chat.prompt);
		} else await expect(pending).rejects.toMatchObject({ status: 409 });
	}
	for (const changed of [selected, { ...selected, name: 'Changed source bytes' }]) {
		gateway.readRepositoryFile.mockResolvedValue({ resolvedRef: commit, file: { path: 'agents/target.yaml', frontmatter: changed } });
		const node = { id: 'addressed-request', kind: 'communication', projectId: 'project', agentClass: 'maintenance', authorityRefs: [reference] };
		const pending = effectiveProfile({ all: async () => [source, source] }, node as never);
		await expect(pending).rejects.toMatchObject({ code: 'execution_node_agent_identity_ambiguous' });
		if (changed !== selected) await expect(effectiveProfile({ all: async () => [source] }, node as never))
			.rejects.toMatchObject({ code: 'execution_node_agent_profile_moved' });
	}
});
