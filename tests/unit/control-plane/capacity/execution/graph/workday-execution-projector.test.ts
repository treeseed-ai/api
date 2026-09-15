import { describe, expect, it } from 'vitest';
import { compileWorkday, validateExecutionGraph } from '@treeseed/sdk/agent-capacity';
import { projectActiveWorkdays } from '../../../../../../src/api/capacity/policy/execution/workday-execution-projector.ts';

const permissions = { content: { read: ['proposal'], write: ['proposal'] }, tools: ['discussion'] };
const definition = (agentClass: string, dependsOn: string[] = []) => ({
	schemaVersion: 'treeseed.agent/v1' as const, id: `sdk/${agentClass}`, name: agentClass, agentClass,
	purpose: `Perform ${agentClass} work.`, responsibilities: ['Return exact results.'], capabilities: ['reasoning'],
	context: { include: ['project-objectives'] }, activityProfiles: {
		planning: { handler: 'writer', permissions, prompt: { system: 'Plan useful governed work.' },
			...(dependsOn.length ? { dependsOn: { agents: dependsOn } } : {}) },
		...(agentClass === 'reporter' ? { reporting: { handler: 'reporter', permissions,
			prompt: { system: 'Commit the deterministic workday report.' }, dependsOn: { events: ['workday-closing' as const] } } } : {}),
	},
});

describe('workday living-graph projection', () => {
	it('projects exactly two planning rounds, standing dependencies, and closing Reporter work', () => {
		const profiles = { 'sdk:architect': definition('architect'), 'sdk:engineer': definition('engineer', ['architect']),
			'sdk:reporter': definition('reporter') };
		const appliedPlan = compileWorkday({ id: 'workday', teamId: 'team', policyId: 'default', policyRevision: 1,
			executionMode: 'simulation',
			policy: { durationSeconds: 3600, maximumConcurrency: 2, planningSecondsPerAgent: 60,
				communicationConcurrency: 1, projectWeights: { sdk: 1 }, agentClassWeights: { architect: 1, engineer: 1, reporter: 1 } },
			agentIds: ['sdk/sdk/architect:planning', 'sdk/sdk/engineer:planning', 'sdk/sdk/reporter:planning'], startsAt: '2026-09-13T12:00:00.000Z' });
		const graph = projectActiveWorkdays({ teamId: 'team', revision: 1,
			sources: [{ id: 'workday', teamId: 'team', parameters: { appliedPlan, scheduledProjectIds: ['sdk'],
				agentProfilesByProjectId: { sdk: { revision: 'test', agents: Object.values(profiles).map((candidate) => ({ definition: candidate, activities: ['planning'] })) } } } }], profiles });
		expect(graph.nodes.filter((node) => node.kind === 'planning')).toHaveLength(6);
		expect(graph.nodes.map((node) => node.kind)).toEqual(expect.arrayContaining(['condition', 'reporting']));
		expect(graph.nodes.find((node) => node.kind === 'reporting')?.estimate)
			.toEqual({ minimumSeconds: 1, expectedSeconds: 5, maximumSeconds: 30 });
		expect(graph.nodes.find((node) => node.kind === 'reporting')?.requiredCapabilities)
			.toEqual(['treeseed.coordination.reporting']);
		expect(graph.nodes.filter((node) => node.kind === 'planning')
			.every((node) => node.requiredCapabilities?.[0] === 'treeseed.coordination.planning')).toBe(true);
		expect(graph.edges.some((edge) => edge.provenance === 'profile-agent'
			&& edge.fromNodeId.includes('architect') && edge.toNodeId.includes('engineer'))).toBe(true);
		expect(graph.edges.filter((edge) => edge.fromNodeId.startsWith('planning:workday:1:')
			&& edge.toNodeId.startsWith('planning:workday:2:'))).toHaveLength(9);
		expect(graph.nodes.filter((node) => node.kind !== 'condition')
			.every((node) => node.authorityRefs?.some((reference) => reference.model === 'workday'))).toBe(true);
		expect(validateExecutionGraph(graph.nodes, graph.edges)).toMatchObject({ ok: true });
	});

	it('projects an explicitly selected estimating profile without falling back to planning', () => {
		const architect = definition('architect') as ReturnType<typeof definition> & { activityProfiles: Record<string, unknown> };
		architect.activityProfiles.estimating = { handler: 'estimate', permissions, prompt: { system: 'Estimate exact work.' } };
		const participantId = 'sdk/sdk/architect:estimating';
		const appliedPlan = compileWorkday({ id: 'estimating-workday', teamId: 'team', policyId: 'default', policyRevision: 1,
			executionMode: 'simulation',
			policy: { durationSeconds: 600, maximumConcurrency: 1, planningSecondsPerAgent: 60,
				communicationConcurrency: 1, projectWeights: {}, agentClassWeights: {} },
			agentIds: [participantId], startsAt: '2026-09-14T12:00:00.000Z' });
		const graph = projectActiveWorkdays({ teamId: 'team', revision: 1, profiles: { 'sdk:architect': architect },
			sources: [{ id: 'estimating-workday', teamId: 'team', parameters: { appliedPlan, scheduledProjectIds: ['sdk'],
				agentSelection: { activityTypes: ['estimating'] },
				agentProfilesByProjectId: { sdk: { revision: 'test', agents: [{ definition: architect, activities: ['estimating'] }] } } } }] });
		expect(graph.nodes.filter((node) => node.kind === 'estimating')).toHaveLength(2);
		expect(graph.nodes.filter((node) => node.kind === 'estimating').every((node) =>
			node.requiredCapabilities?.[0] === 'treeseed.coordination.estimation')).toBe(true);
		expect(graph.nodes.some((node) => node.kind === 'planning')).toBe(false);
	});

	it('does not manufacture subjectless planning rounds for a selected review activity', () => {
		const reviewer = definition('reviewer') as ReturnType<typeof definition> & { activityProfiles: Record<string, unknown> };
		reviewer.activityProfiles.reviewing = { handler: 'writer', permissions, prompt: { system: 'Review exact governed work.' } };
		const appliedPlan = compileWorkday({ id: 'review-workday', teamId: 'team', policyId: 'default', policyRevision: 1,
			executionMode: 'simulation',
			policy: { durationSeconds: 600, maximumConcurrency: 1, planningSecondsPerAgent: 60,
				communicationConcurrency: 1, projectWeights: {}, agentClassWeights: {} },
			agentIds: [], startsAt: '2026-09-14T12:00:00.000Z' });
		const graph = projectActiveWorkdays({ teamId: 'team', revision: 1, profiles: { 'sdk:reviewer': reviewer },
			sources: [{ id: 'review-workday', teamId: 'team', parameters: { appliedPlan, scheduledProjectIds: ['sdk'],
				agentSelection: { activityTypes: ['reviewing'] },
				agentProfilesByProjectId: { sdk: { revision: 'test', agents: [{ definition: reviewer, activities: ['reviewing'] }] } } } }] });
		expect(graph.nodes.filter((node) => node.kind === 'reviewing')).toHaveLength(0);
		expect(graph.nodes.filter((node) => node.kind === 'planning')).toHaveLength(0);
	});
});
