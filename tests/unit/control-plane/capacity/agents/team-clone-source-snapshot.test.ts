import { describe, expect, it, vi } from 'vitest';
import { serializeFrontmatterDocument } from '../../../../../src/api/content/frontmatter.ts';
import { snapshotAgents } from '../../../../../src/api/capacity/services/capacity/agents/team-clone/agent-team-clone-service.ts';

const commit = 'a'.repeat(40);
const definition = {
	schemaVersion: 'treeseed.agent/v1', id: 'sdk/architect', name: 'SDK Architect', agentClass: 'architect',
	purpose: 'Guide SDK architecture.', responsibilities: ['Answer bounded questions.'], capabilities: ['reasoning'],
	context: { include: ['project-objectives'] },
	activityProfiles: { chat: { handler: 'writer', permissions: {
		content: { read: ['discussion'], write: ['discussion'] }, tools: ['discussion'],
	}, prompt: { system: 'Research authorized context before answering.' } } },
};

function connection(files: Array<{ path: string; content: string }>, paths = files.map((file) => file.path)) {
	return { baseRef: commit, contentPath: '.', repositoryId: 'sdk-library', client: {
		listRepositoryPaths: vi.fn(async () => ({ resolvedRef: commit, entries: paths.map((path) => ({ path })) })),
		readRepositoryFiles: vi.fn(async () => ({ resolvedRef: commit, files })),
	} } as never;
}

describe('exact TreeDX agent-team source snapshot', () => {
	it('accepts a complete valid snapshot', async () => {
		const path = 'agents/architect.mdx';
		const result = await snapshotAgents(connection([{ path, content: serializeFrontmatterDocument(definition) }]));
		expect(result).toMatchObject({ commit, files: [{ path, definition: { agentClass: 'architect' } }] });
	});

	it('rejects a collection resolved to a different commit than the requested source', async () => {
		const source = connection([]) as { client: { listRepositoryPaths: ReturnType<typeof vi.fn> } };
		source.client.listRepositoryPaths.mockResolvedValue({ resolvedRef: 'b'.repeat(40), entries: [] });
		await expect(snapshotAgents(source as never, commit)).rejects.toMatchObject({ code: 'agent_team_snapshot_moved' });
	});

	it('fails closed when TreeDX omits a listed definition', async () => {
		await expect(snapshotAgents(connection([], ['agents/architect.mdx']))).rejects.toThrow(/every exact agent definition/u);
	});

	it('fails closed instead of silently dropping an invalid definition', async () => {
		await expect(snapshotAgents(connection([{ path: 'agents/invalid.mdx', content: '---\nid: invalid\n---\n' }])))
			.rejects.toMatchObject({ code: 'agent_team_definition_invalid' });
	});

	it('rejects two definitions that would overwrite the same target agent class', async () => {
		const files = ['first', 'second'].map((name) => ({ path: `agents/${name}.mdx`,
			content: serializeFrontmatterDocument({ ...definition, id: `sdk/${name}` }) }));
		await expect(snapshotAgents(connection(files))).rejects.toMatchObject({ code: 'agent_team_class_ambiguous' });
	});
});
