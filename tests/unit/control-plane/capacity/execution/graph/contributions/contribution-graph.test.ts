import { expect, it } from 'vitest';
import { assignmentAttemptSchema, type AgentDefinition } from '@treeseed/sdk/agent-capacity';
import { projectTeamExecutionGraph } from '../../../../../../../src/api/capacity/policy/execution/execution-graph-projector.ts';
import { assignment as original } from '../../fixtures/assignment.ts';

function input() {
	const sourceRef = { store: 'treedx' as const, model: 'proposal', id: 'runner-repair', revision: 3,
		digest: `sha256:${'a'.repeat(64)}`, repository: 'project-library', commit: 'a'.repeat(40), path: 'proposals/runner-repair.mdx' };
	const permissions = { content: { read: ['proposal', 'decision'], write: ['decision'] }, tools: ['source.read'] };
	const profile = { handler: 'writer', permissions, prompt: { system: 'Contribute to the actual accepted runner repair.' } };
	const names = ['technical-writer', 'tester', 'engineer'];
	const definitions = names.map(name => ({ schemaVersion: 'treeseed.agent/v1', id: `project/${name}`, name,
		agentClass: 'maintenance', purpose: 'Repair actual portfolio source.', responsibilities: ['Own useful source work.'],
		capabilities: ['source-repair'], context: { include: ['project'] }, groupIds: ['provider-runtime'],
		activityProfiles: { acting: profile, reviewing: profile, estimating: profile },
	} as AgentDefinition));
	const attempts = definitions.map((definition, index) => assignmentAttemptSchema.parse({ ...original,
		id: `estimate-${names[index]}`, sourceRef, agentClass: 'maintenance', effectiveProfile: {
			...original.effectiveProfile, activity: 'estimating', profileRef: { store: 'treedx', model: 'agent', id: definition.id,
				repository: 'project-library', commit: 'b'.repeat(40), path: `agents/${names[index]}.mdx` },
		} }));
	const workItems = names.map((name, index) => ({ id: `${name}-work`, activity: 'acting',
		objective: `Deliver the ${name} contribution to the prepared workload handoff repair.`, workspace: 'read-only',
		review: 'required', maximumReviewCycles: 2, dependsOn: index ? [`${names[index - 1]}-work`] : [],
		estimateRef: { store: 'postgresql', model: 'assignment-attempt', id: attempts[index]!.id, revision: attempts[index]!.attempt },
		estimate: { expectedSeconds: 100 + index, maximumSeconds: 200 + index, rationale: `Own ${name} implementation effort.` },
		reviewEstimate: { expectedSeconds: 50 + index, maximumSeconds: 80 + index, rationale: `Own ${name} peer-review effort.` },
		requestedPermissions: { ...permissions, content: { read: permissions.content.read, write: [] } }, requiredCapabilities: ['treeseed.research.verification'],
		acceptanceCriteria: ['Preserve the prepared model request and return the exact changed source.'],
	}));
	const source = { teamId: 'team', projectId: 'project', repository: sourceRef.repository, path: sourceRef.path,
		commit: sourceRef.commit, digest: sourceRef.digest, proposalRevision: 3, estimatingAttempts: attempts,
		frontmatter: { schemaVersion: 'treeseed.proposal/v2', id: sourceRef.id, projectId: 'project', groupIds: ['provider-runtime'],
			title: 'Repair the prepared workload handoff', request: 'Document, reproduce and repair the real workload input boundary.',
			summary: 'Documentation drives reproduction and source repair.', status: 'ready', executionPlan: { workItems } },
		decision: { id: 'decision', revision: 1, digest: `sha256:${'c'.repeat(64)}`, current: true,
			repository: 'project-library', path: 'decisions/runner-repair.mdx', commit: 'c'.repeat(40) },
	};
	return { teamId: 'team', revision: 1, sources: [source], profiles: Object.fromEntries(definitions.map(definition => [`project:${definition.id}`, definition])) };
}

it('binds each same-class author to its own acting work and another author own review budget in documentation-first dependency order', () => {
	const supplied = input(), before = structuredClone(supplied), graph = projectTeamExecutionGraph(supplied);
	const items = supplied.sources[0]!.frontmatter.executionPlan.workItems;
	for (const item of items) {
		const actor = graph.nodes.find(node => node.workItemId === item.id && node.kind === 'acting')!;
		const review = graph.nodes.find(node => node.workItemId === item.id && node.kind === 'reviewing')!;
		const actorId = actor.authorityRefs!.find(ref => ref.model === 'agent')!.id;
		const reviewerId = review.authorityRefs!.find(ref => ref.model === 'agent')!.id;
		expect(actorId).toBe(`project/${item.id.replace(/-work$/u, '')}`);
		expect(reviewerId).not.toBe(actorId); expect(actor.agentClass).toBe('maintenance'); expect(review.agentClass).toBe('maintenance');
		expect(actor.estimate).toEqual(item.estimate);
		const budget = items.find(candidate => `project/${candidate.id.replace(/-work$/u, '')}` === reviewerId)!;
		expect(review.estimate).toEqual(budget.reviewEstimate);
		expect(review.authorityRefs).toContainEqual(budget.estimateRef);
		expect(graph.edges).toContainEqual(expect.objectContaining({ fromNodeId: actor.id, toNodeId: review.id, provenance: 'review-pair' }));
		for (const dependency of item.dependsOn) expect(graph.edges).toContainEqual(expect.objectContaining({
			fromNodeId: graph.nodes.find(node => node.workItemId === dependency && node.kind === 'reviewing')!.id,
			toNodeId: actor.id, provenance: 'work-item',
		}));
	}
	expect(supplied).toEqual(before);
});

it('refuses missing forged moved foreign or unsubscribed contributor authority and infeasible independent review', () => {
	for (const fault of ['missing', 'forged', 'ordinal', 'foreign', 'unsubscribed', 'self-only'] as const) {
		const supplied = input(), source = supplied.sources[0]!;
		if (fault === 'missing') source.estimatingAttempts = [];
		if (fault === 'forged') source.frontmatter.executionPlan.workItems[0]!.estimateRef.id = 'unverified-attempt';
		if (fault === 'ordinal') source.frontmatter.executionPlan.workItems[0]!.estimateRef.revision++;
		if (fault === 'foreign') source.estimatingAttempts[0]!.teamId = 'foreign';
		if (fault === 'unsubscribed') Object.values(supplied.profiles)[0]!.groupIds = ['another-team'];
		if (fault === 'self-only') { source.frontmatter.executionPlan.workItems.splice(1); source.estimatingAttempts.splice(1); }
		const before = structuredClone(supplied);
		expect(() => projectTeamExecutionGraph(supplied)).toThrow(); expect(supplied).toEqual(before);
	}
});

it('keeps cross-project subscribers with the same configured name independent without a hidden project filter', () => {
	const supplied = input(), source = supplied.sources[0]!, projects = ['ui', 'admin'];
	source.frontmatter.executionPlan.workItems.splice(2); source.estimatingAttempts.splice(2);
	const definitions = Object.values(supplied.profiles).slice(0, 2);
	supplied.profiles = Object.fromEntries(definitions.map((definition, index) => {
		const projectId = projects[index]!, attempt = source.estimatingAttempts[index]!;
		definition.id = 'shared-worker'; definition.name = 'Shared worker'; attempt.projectId = projectId;
		Object.assign(attempt.effectiveProfile.profileRef, { id: definition.id, repository: `${projectId}-library`, path: 'agents/shared-worker.mdx' });
		return [`${projectId}:${definition.id}`, definition];
	}));
	const before = structuredClone(supplied), graph = projectTeamExecutionGraph(supplied);
	for (const actor of graph.nodes.filter(node => node.kind === 'acting')) {
		const reviewId = graph.edges.find(edge => edge.fromNodeId === actor.id && edge.provenance === 'review-pair')!.toNodeId;
		const reviewer = graph.nodes.find(node => node.id === reviewId)!;
		expect(reviewer.projectId).not.toBe(actor.projectId);
		expect(reviewer.authorityRefs!.find(ref => ref.model === 'agent')!.id).toBe('shared-worker');
		expect(actor.authorityRefs!.find(ref => ref.model === 'agent')!.id).toBe('shared-worker');
	}
	expect(supplied).toEqual(before);
});
