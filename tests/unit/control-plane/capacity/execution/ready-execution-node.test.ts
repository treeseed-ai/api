import { describe, expect, it, vi } from 'vitest';
import { listReadyExecutionNodes } from '../../../../../src/api/capacity/services/build/ready-execution-node.ts';

const projectId = 'project';
const sourceRef = {
	store: 'treedx', model: 'proposal', id: 'proposal', revision: 1,
	digest: `sha256:${'a'.repeat(64)}`, repository: 'repository', commit: 'b'.repeat(40), path: 'proposals/one.mdx',
};
const decisionRef = { store: 'postgresql', model: 'decision', id: 'decision', revision: 1, digest: `sha256:${'c'.repeat(64)}` };
const permissions = { content: { read: ['proposal', 'decision'], write: [] }, tools: ['source.read'] };

function nodeRow(id = 'node', decisionId = 'decision') {
	return {
		id, team_id: 'team', project_id: projectId, work_item_id: 'implementation',
		kind: 'acting', pair_role: 'actor', source_ref_json: sourceRef,
		authority_refs_json: [{ ...decisionRef, id: decisionId }],
		rule_revision: 1, node_revision: 1, agent_class: 'engineer', status: 'ready',
		estimate_json: { minimumSeconds: 60, expectedSeconds: 120, maximumSeconds: 180 },
		required_capabilities_json: ['code-change'], requested_permissions_json: permissions,
		workspace: 'git', acceptance_criteria_json: ['Tests pass.'], maximum_review_cycles: 2,
		graph_revision_created: 1, graph_revision_updated: 4, current_graph_revision: 4,
	};
}

const definition = {
	schemaVersion: 'treeseed.agent/v1', id: 'agent:engineer', name: 'Engineer', agentClass: 'engineer',
	purpose: 'Implement accepted source changes.', responsibilities: ['Return one verified result.'],
	capabilities: ['code-change'], context: { include: ['project'] },
	activityProfiles: {
		acting: {
			handler: 'actor', permissions,
			prompt: { system: 'Implement the accepted work and verify the resulting source.' },
		},
	},
};

const result = {
	schemaVersion: 'treeseed.assignment-result/v1', id: 'result-one', assignmentId: 'assignment-one',
	status: 'completed', summary: 'Architecture completed.',
	references: [{ kind: 'git', repository: 'treeseed-ai/sdk', commit: 'd'.repeat(40) }],
	verification: [], usage: { elapsedSeconds: 30 }, diagnostics: [], completedAt: '2026-09-13T12:00:00.000Z',
};

const run = { id: 'run', teamId: 'team', parameters: { decisionIds: ['decision'] } };
const project = { id: projectId, slug: 'sdk' };
const contextRefs = [{ store: 'git' as const, model: 'repository', id: 'sdk', repository: 'treeseed-ai/sdk', commit: 'e'.repeat(40) }];
const teamContextStore = {
	getProjectByTeamAndSlug: vi.fn(async () => ({ id: 'team-project', slug: 'team' })),
	getProjectTreeDxLibrary: vi.fn(async () => ({ repositoryId: 'team-repository', metadata: { resolvedRef: 'f'.repeat(40) } })),
	listHubRepositories: vi.fn(async () => [{ id: 'repository-sdk', role: 'software', provider: 'github', owner: 'treeseed-ai', name: 'sdk', currentBranch: 'staging' }]),
};

describe('direct ready-node admission input', () => {
	it('loads the exact profile and predecessor results without creating a demand record', async () => {
		const store = { ...teamContextStore, all: vi.fn()
			.mockResolvedValueOnce([nodeRow()])
			.mockResolvedValueOnce([{ id: 'class-engineer', handler_refs_json: { agents: [definition] } }])
			.mockResolvedValueOnce([{ assignment_result_json: result }]) };
		const [candidate] = await listReadyExecutionNodes(store, run as never, project as never, async () => contextRefs);
		expect(candidate).toMatchObject({
			graphRevision: 4, projectAgentClassId: 'class-engineer',
			node: { id: 'node', estimate: { minimumSeconds: 60, expectedSeconds: 120, maximumSeconds: 180 } },
			effectiveProfile: { handler: 'actor', activity: 'acting', handlerOrigin: 'agent-package', permissionCeiling: permissions },
			predecessorResults: [result],
		});
		expect(candidate.contextRefs).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: 'team-project:team-readme', path: 'README.md', commit: 'f'.repeat(40) }),
			expect.objectContaining({ id: 'team-project:team-objective', path: 'objectives/core', commit: 'f'.repeat(40) }),
		]));
		expect(candidate.sourceRepositories).toEqual(['repository-sdk']);
		expect(JSON.stringify(candidate)).not.toMatch(/capacityPlan|demand|sourceCandidate|artifactManifest/u);
	});

	it('limits admission to decision IDs frozen into the workday', async () => {
		const store = { ...teamContextStore, all: vi.fn().mockResolvedValueOnce([nodeRow('selected'), nodeRow('other', 'other-decision')])
			.mockResolvedValueOnce([{ id: 'class-engineer', handler_refs_json: { agents: [definition] } }])
			.mockResolvedValueOnce([]) };
		const candidates = await listReadyExecutionNodes(store, run as never, project as never, async () => contextRefs);
		expect(candidates.map((candidate) => candidate.node.id)).toEqual(['selected']);
	});

	it('fails closed when the exact activity profile is unavailable', async () => {
		const store = { ...teamContextStore, all: vi.fn().mockResolvedValueOnce([nodeRow()]).mockResolvedValueOnce([]) };
		await expect(listReadyExecutionNodes(store, run as never, project as never, async () => contextRefs))
			.rejects.toMatchObject({ code: 'execution_node_agent_profile_missing' });
	});

	it('passes the prior exact Reviewer result to a revised Actor node', async () => {
		const revised = nodeRow(); revised.node_revision = 18;
		const reviewResult = { ...result, id: 'review-result', assignmentId: 'review-assignment',
			summary: 'Request changes using the exact review decision.', references: [{ kind: 'treedx', projectId,
				repository: 'repository', commit: 'f'.repeat(40), path: 'decisions/review.mdx' }] };
		const store = { ...teamContextStore, all: vi.fn()
			.mockResolvedValueOnce([revised])
			.mockResolvedValueOnce([{ id: 'class-engineer', handler_refs_json: { agents: [definition] } }])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ assignment_result_json: result }])
			.mockResolvedValueOnce([{ assignment_result_json: reviewResult }]) };
		const [candidate] = await listReadyExecutionNodes(store, { ...run, parameters: {} } as never, project as never, async () => contextRefs);
		expect(candidate.predecessorResults).toEqual([result, reviewResult]);
		expect(candidate.contextRefs).toEqual(expect.arrayContaining([
			expect.objectContaining({ store: 'git', commit: 'd'.repeat(40) }),
		]));
		expect(store.all.mock.calls[3]![1]).toEqual(['team', 'node', 18]);
		expect(store.all.mock.calls[4]![1]).toEqual(['team', projectId, 'implementation']);
	});
});
