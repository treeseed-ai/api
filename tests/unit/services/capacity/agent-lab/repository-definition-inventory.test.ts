import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listRepositoryPaths, readRepositoryFiles } = vi.hoisted(() => ({
	listRepositoryPaths: vi.fn(),
	readRepositoryFiles: vi.fn(),
}));

vi.mock('../../../../../src/api/knowledge/gateway-treedx-connection.ts', () => ({
	resolveKnowledgeGatewayConnection: vi.fn(async () => ({
		contentPath: 'src/content', repositoryId: 'repository-1', baseRef: 'commit-one',
		client: { listRepositoryPaths, readRepositoryFiles },
	})),
}));

import { agentLabRepositoryDefinitions, invalidateAgentLabRepositoryDefinitions, matchesAgentDefinition, unmatchedAgentDefinitions } from '../../../../../src/api/capacity/routes/support/agent-lab/repository-definitions.ts';

const repositoryAgent = (projectId: string, slug: string) => ({
	id: `definition:${projectId}:src/content/agents/${slug}.mdx`,
	kind: 'agent',
	projectId,
	data: { contractId: slug, path: `src/content/agents/${slug}.mdx` },
});

describe('Agent Lab repository definition inventory', () => {
	beforeEach(() => {
		listRepositoryPaths.mockReset().mockResolvedValue({
			resolvedRef: 'commit-one', entries: [{ path: 'src/content/agents/reviewer.mdx' }],
		});
		readRepositoryFiles.mockReset().mockResolvedValue({
			resolvedRef: 'commit-one', files: [{ path: 'src/content/agents/reviewer.mdx', content: '---\nid: reviewer\nslug: reviewer\nname: Reviewer\nactivityProfiles: {}\n---\nReview work.' }],
		});
	});

	it('matches a durable class only within the same project', () => {
		const definition = repositoryAgent('project-one', 'guide-steward');
		expect(matchesAgentDefinition({ projectId: 'project-one', slug: 'guide-steward' }, definition)).toBe(true);
		expect(matchesAgentDefinition({ projectId: 'project-two', slug: 'guide-steward' }, definition)).toBe(false);
	});

	it('keeps repository-authoritative agents visible before class reconciliation', () => {
		const matched = repositoryAgent('project-one', 'guide-steward');
		const repositoryOnly = repositoryAgent('project-one', 'new-reviewer');
		const signal = { id: 'signal-one', kind: 'signal', projectId: 'project-one', data: {} };
		expect(unmatchedAgentDefinitions(
			[{ id: 'class-one', kind: 'agent', projectId: 'project-one', slug: 'guide-steward' }],
			[matched, repositoryOnly, signal],
		)).toEqual([repositoryOnly]);
	});

	it('deduplicates concurrent TreeDX reads and invalidates the project after authoring', async () => {
		const dependencies = { store: {} } as never; const projects = [{ id: 'project-one', name: 'Project One' }];
		const [first, second] = await Promise.all([
			agentLabRepositoryDefinitions(dependencies, projects),
			agentLabRepositoryDefinitions(dependencies, projects),
		]);
		expect(first).toEqual(second);
		expect(listRepositoryPaths).toHaveBeenCalledOnce();
		expect(readRepositoryFiles).toHaveBeenCalledOnce();

		invalidateAgentLabRepositoryDefinitions(dependencies, 'project-one');
		await agentLabRepositoryDefinitions(dependencies, projects);
		expect(listRepositoryPaths).toHaveBeenCalledTimes(2);
		expect(readRepositoryFiles).toHaveBeenCalledTimes(2);
	});
});
