import { describe, expect, it } from 'vitest';
import type { AgentDefinition } from '@treeseed/sdk/agent-capacity';
import {
	projectTeamExecutionGraph,
	type ExecutableProposalSource,
} from '../../../../../../src/api/capacity/policy/execution/execution-graph-projector.ts';

const permissions = {
	content: { read: ['proposal', 'decision', 'knowledge'] as const, write: [] },
	tools: ['source.read'] as const,
};

function agent(agentClass: string, dependsOn: string[] = []): AgentDefinition {
	return {
		schemaVersion: 'treeseed.agent/v1',
		id: `agent:${agentClass}`,
		name: agentClass,
		agentClass,
		purpose: `Perform ${agentClass} work.`,
		responsibilities: [`Complete bounded ${agentClass} assignments.`],
		capabilities: [`treeseed.agent.${agentClass}`],
		context: { include: ['project'] },
		activityProfiles: agentClass === 'reviewer' ? {
			reviewing: {
				handler: 'reviewer',
				permissions: permissions as never,
				prompt: { system: 'Review the exact candidate against its acceptance criteria.' },
			},
		} : {
			acting: {
				handler: agentClass,
				...(dependsOn.length ? { dependsOn: { agents: dependsOn } } : {}),
				permissions: permissions as never,
				prompt: { system: `Execute the exact accepted ${agentClass} work item and verify it.` },
			},
		},
	};
}

const profiles = {
	'project:architect': agent('architect'),
	'project:tester': agent('tester', ['architect']),
	'project:engineer': agent('engineer', ['tester']),
	'project:reviewer': agent('reviewer'),
};

const workItem = (input: {
	id: string; agentClass: string; dependsOn?: string[]; review?: 'required' | 'none';
	minimumSeconds: number; expectedSeconds: number; maximumSeconds: number;
}) => ({
	id: input.id,
	activity: 'acting',
	agentClass: input.agentClass,
	workspace: 'git',
	review: input.review ?? 'required',
	objective: `Complete ${input.id}.`,
	estimate: {
		minimumSeconds: input.minimumSeconds,
		expectedSeconds: input.expectedSeconds,
		maximumSeconds: input.maximumSeconds,
	},
	...(input.review !== 'none' ? {
		reviewEstimate: { minimumSeconds: 10, expectedSeconds: 20, maximumSeconds: 30 },
		maximumReviewCycles: 2,
	} : {}),
	dependsOn: input.dependsOn ?? [],
	requestedPermissions: permissions,
	requiredCapabilities: [`treeseed.agent.${input.agentClass}`],
	contextRefs: [{ store: 'git', model: 'repository', id: 'sdk', repository: 'treeseed-ai/sdk', commit: 'e'.repeat(40) }],
	acceptanceCriteria: [`${input.id} is verified.`],
});

function source(items = [
	workItem({ id: 'architecture', agentClass: 'architect', minimumSeconds: 30, expectedSeconds: 60, maximumSeconds: 90 }),
	workItem({ id: 'tests', agentClass: 'tester', minimumSeconds: 60, expectedSeconds: 120, maximumSeconds: 180 }),
	workItem({ id: 'implementation', agentClass: 'engineer', dependsOn: ['tests'], minimumSeconds: 120, expectedSeconds: 240, maximumSeconds: 480 }),
]): ExecutableProposalSource {
	return {
		teamId: 'team', projectId: 'project', repository: 'treeseed-ai/sdk',
		path: 'proposals/agent-runtime.mdx', commit: 'a'.repeat(40), digest: `sha256:${'b'.repeat(64)}`,
		proposalRevision: 1,
		decision: { id: 'decision', revision: 1, digest: `sha256:${'c'.repeat(64)}`, current: true },
		frontmatter: {
			schemaVersion: 'treeseed.proposal/v1',
			id: 'agent-runtime', projectId: 'project', title: 'Agent runtime',
			request: 'Build the accepted agent runtime.',
			summary: 'Compile the accepted work units without changing their topology during allocation.',
			status: 'decided',
			executionPlan: { workItems: items },
		},
	};
}

describe('proposal-owned living execution graph projection', () => {
	it('derives stable actor and reviewer nodes from each accepted work item', () => {
		const graph = projectTeamExecutionGraph({ teamId: 'team', revision: 1, sources: [source()], profiles, createdAt: '2026-09-13T12:00:00.000Z' });
		expect(graph.nodes).toHaveLength(6);
		expect(graph.nodes.filter((node) => node.pairRole === 'actor')).toHaveLength(3);
		expect(graph.nodes.filter((node) => node.pairRole === 'reviewer')).toHaveLength(3);
		expect(graph.edges.filter((edge) => edge.provenance === 'review-pair')).toHaveLength(3);
		expect(graph.nodes.every((node) => node.sourceRef.model === 'proposal')).toBe(true);
		expect(graph.nodes.filter((node) => node.pairRole === 'reviewer')
			.every((node) => node.requiredCapabilities?.[0] === 'treeseed.engineering.review')).toBe(true);
	});

	it('uses exact work-item and profile dependencies without changing estimates', () => {
		const graph = projectTeamExecutionGraph({ teamId: 'team', revision: 1, sources: [source()], profiles });
		const actor = (id: string) => graph.nodes.find((node) => node.workItemId === id && node.pairRole === 'actor')!;
		const reviewer = (id: string) => graph.nodes.find((node) => node.workItemId === id && node.pairRole === 'reviewer')!;
		expect(actor('implementation').estimate).toEqual({ minimumSeconds: 120, expectedSeconds: 240, maximumSeconds: 480 });
		expect(graph.edges).toEqual(expect.arrayContaining([
			expect.objectContaining({ fromNodeId: reviewer('architecture').id, toNodeId: actor('tests').id, provenance: 'profile-agent' }),
			expect.objectContaining({ fromNodeId: reviewer('tests').id, toNodeId: actor('implementation').id, provenance: 'work-item' }),
			expect.objectContaining({ fromNodeId: reviewer('tests').id, toNodeId: actor('implementation').id, provenance: 'profile-agent' }),
		]));
		expect(actor('architecture').status).toBe('ready');
		expect(actor('tests').status).toBe('blocked');
	});

	it('projects an exact cross-project TreeDX link from approved reviewer to dependent actor', () => {
		const sdk = source([workItem({ id: 'simulate-release', agentClass: 'architect', minimumSeconds: 30, expectedSeconds: 60, maximumSeconds: 90 })]);
		const apiBase = source([workItem({ id: 'tests-first', agentClass: 'tester', minimumSeconds: 30, expectedSeconds: 60, maximumSeconds: 90 })]);
		const api = { ...apiBase,
			projectId: 'api', repository: 'treeseed-ai/api', path: 'proposals/api.mdx',
			frontmatter: { ...apiBase.frontmatter, id: 'api-plan', projectId: 'api' } };
		const endpoint = (candidate: ExecutableProposalSource, anchor: string) => ({
			store: 'treedx' as const, model: 'proposal', id: String(candidate.frontmatter.id),
			revision: candidate.proposalRevision, digest: candidate.digest, repository: candidate.repository,
			commit: candidate.commit, path: candidate.path, anchor,
		});
		const noteRef = { store: 'treedx' as const, model: 'note', id: 'dependency', repository: api.repository,
			commit: 'd'.repeat(40), path: 'notes/dependency.md', digest: `sha256:${'e'.repeat(64)}` };
		const graph = projectTeamExecutionGraph({ teamId: 'team', revision: 1, sources: [sdk, api],
			profiles: { ...profiles, 'api:tester': agent('tester'), 'api:reviewer': agent('reviewer') },
			dependencyLinks: [{ from: endpoint(sdk, 'work-item/simulate-release'), to: endpoint(api, 'work-item/tests-first'), sourceRef: noteRef }] });
		const precursor = graph.nodes.find((node) => node.projectId === 'project' && node.workItemId === 'simulate-release' && node.pairRole === 'reviewer')!;
		const dependent = graph.nodes.find((node) => node.projectId === 'api' && node.workItemId === 'tests-first' && node.pairRole === 'actor')!;
		expect(graph.edges).toContainEqual(expect.objectContaining({ fromNodeId: precursor.id, toNodeId: dependent.id,
			provenance: 'treedx-link', sourceRef: noteRef }));
		expect(() => projectTeamExecutionGraph({ teamId: 'team', revision: 1, sources: [api],
			profiles: { 'api:tester': agent('tester'), 'api:reviewer': agent('reviewer') },
			dependencyLinks: [{ from: endpoint(sdk, 'work-item/simulate-release'), to: endpoint(api, 'work-item/tests-first'), sourceRef: noteRef }] }))
			.toThrow('absent from the selected graph');
	});

	it('is replay deterministic and contains no provider selection or output taxonomy', () => {
		const first = projectTeamExecutionGraph({ teamId: 'team', revision: 1, sources: [source()], profiles, createdAt: '2026-09-13T12:00:00.000Z' });
		const second = projectTeamExecutionGraph({ teamId: 'team', revision: 1, sources: [source()], profiles, createdAt: '2026-09-13T13:00:00.000Z' });
		expect(second.revision.graphDigest).toBe(first.revision.graphDigest);
		expect(second.nodes.map((node) => node.id)).toEqual(first.nodes.map((node) => node.id));
		expect(JSON.stringify(first)).not.toMatch(/providerId|outputType|produces|artifactManifest|sourceCandidate/u);
	});

	it('projects exactly one proposal Reviewer without current decision authority', () => {
		const candidate = source();
		candidate.decision = null;
		candidate.frontmatter.status = 'ready';
		const graph = projectTeamExecutionGraph({ teamId: 'team', revision: 1, sources: [candidate], profiles });
		expect(graph.nodes).toEqual([expect.objectContaining({ kind: 'reviewing', pairRole: null,
			agentClass: 'reviewer', status: 'ready', workspace: 'treedx', sourceRef: expect.objectContaining({ id: 'agent-runtime' }),
			requiredCapabilities: ['treeseed.engineering.review'],
			estimate: { minimumSeconds: 30, expectedSeconds: 60, maximumSeconds: 90 } })]);
		expect(graph.edges).toEqual([]);
	});

	it('keeps work blocked when a standing agent dependency has no concrete work item', () => {
		const graph = projectTeamExecutionGraph({ teamId: 'team', revision: 1, sources: [source([
			workItem({ id: 'implementation', agentClass: 'engineer', minimumSeconds: 120, expectedSeconds: 240, maximumSeconds: 480 }),
		])], profiles });
		const actor = graph.nodes.find((node) => node.workItemId === 'implementation' && node.pairRole === 'actor')!;
		const condition = graph.nodes.find((node) => node.kind === 'condition')!;
		expect(condition).toMatchObject({ status: 'blocked', authorityRefs: [],
			condition: { conditionType: 'external', expectedState: 'agent-class:tester' } });
		expect(actor.status).toBe('blocked');
		expect(graph.edges).toContainEqual(expect.objectContaining({
			fromNodeId: condition.id, toNodeId: actor.id, provenance: 'profile-agent',
		}));
	});
});
