import { describe, expect, it } from 'vitest';
import { compileWorkday, validateExecutionGraph } from '@treeseed/sdk/agent-capacity';
import { projectActiveWorkdays } from '../../../../../../src/api/capacity/policy/execution/workday-execution-projector.ts';
import { workdayParticipants } from '../../../../../../src/api/capacity/policy/execution/workday-participants.ts';

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
	it('keeps policy authority stable across operational accounting and repeated rounds', () => {
		const architect = definition('architect');
		const plan = compileWorkday({ id: 'stable', teamId: 'team', policyId: 'default', policyRevision: 1,
			executionMode: 'simulation', agentIds: ['sdk/sdk/architect:planning'], startsAt: '2026-09-16T12:00:00Z',
			policy: { durationSeconds: 1800, maximumConcurrency: 1, communicationConcurrency: 1 } });
		const project = (appliedPlan: typeof plan) => projectActiveWorkdays({ teamId: 'team', revision: 1,
			profiles: { 'sdk:architect': architect }, sources: [{ id: plan.id, teamId: 'team',
				parameters: { appliedPlan, scheduledProjectIds: ['sdk'] } }] });
		const original = project(plan);
		const advanced = project({ ...plan, state: 'active', activatedAt: '2026-09-16T12:00:01Z',
			admittedSecondsByProject: { sdk: 180 }, admittedSecondsByAgentClass: { 'sdk:architect': 180 },
			planningRounds: [...plan.planningRounds, { round: 2, state: 'pending', assignmentIds: [] }] });
		expect(advanced.changedSourceRefs).toEqual(original.changedSourceRefs);
		expect(project({ ...plan, policySnapshot: { ...plan.policySnapshot, allocationWeight: 2 } }).changedSourceRefs)
			.not.toEqual(original.changedSourceRefs);
	});
	it('automatically admits only proposal work owners and Reviewer to estimating; autonomous planning remains valid', () => {
		const classes = ['engineer', 'reviewer', 'reporter'];
		const agents = classes.map(agentClass => {
			const agent = definition(agentClass);
			return { definition: { ...agent, activityProfiles: { ...agent.activityProfiles,
				estimating: { handler: 'estimate', permissions, prompt: { system: 'Estimate exact work.' } } } },
				activities: ['planning', 'estimating'] };
		});
		const parameters = { agentProfilesByProjectId: { sdk: { agents } } };
		expect(workdayParticipants(parameters).map(participant => participant.activity)).toEqual(['planning', 'planning', 'planning']);
		const participants = workdayParticipants({ ...parameters, proposalsByProjectId: { sdk: { executionPlan: {
			workItems: [{ id: 'implementation', agentClass: 'engineer', review: 'required' }] } } } });
		expect(participants.filter(participant => participant.activity === 'estimating').map(participant => participant.definition.agentClass))
			.toEqual(['engineer', 'reviewer']);
	});
	it('projects six work-owner estimates and one Reviewer covering all six paired reviews', () => {
		const owners = ['researcher', 'architect', 'tester', 'engineer', 'technical-writer', 'releaser'];
		const classes = [...owners, 'reviewer'];
		const profiles = Object.fromEntries(classes.map((agentClass) => {
			const agent = definition(agentClass) as ReturnType<typeof definition> & { activityProfiles: Record<string, unknown> };
			agent.activityProfiles.estimating = { handler: 'estimate', permissions, prompt: { system: 'Estimate the exact proposal work.' } };
			return [`sdk:${agentClass}`, agent];
		}));
		const appliedPlan = compileWorkday({ id: 'seven-estimates', teamId: 'team', policyId: 'default', policyRevision: 1,
			executionMode: 'simulation', activityTypes: ['estimating'],
			policy: { durationSeconds: 1800, maximumConcurrency: 1, planningTurnMaximumSeconds: 60,
				communicationConcurrency: 1, projectPercentages: {}, agentClassPercentages: {} },
			agentIds: classes.map((agentClass) => `sdk/sdk/${agentClass}:estimating`), startsAt: '2026-09-14T12:00:00.000Z' });
		const graph = projectActiveWorkdays({ teamId: 'team', revision: 1, profiles,
			sources: [{ id: 'seven-estimates', teamId: 'team', proposalsByProjectId: { sdk: { executionPlan: {
				workItems: owners.map((agentClass) => ({ id: `${agentClass}-work`, agentClass, review: 'required', acceptanceCriteria: ['Meet the exact work-item boundary.'] })),
			} } }, parameters: { appliedPlan, scheduledProjectIds: ['sdk'],
				planningSourceByProjectId: { sdk: { store: 'treedx', model: 'proposal', id: 'proposal', revision: 1,
					repository: 'sdk-library', commit: 'b'.repeat(40), path: 'proposals/golden.mdx' } },
				agentProfilesByProjectId: { sdk: { agents: Object.values(profiles).map((agent) => ({ definition: agent, activities: ['estimating'] })) } },
			} }] });
		expect(graph.nodes).toHaveLength(7);
		expect(graph.edges).toHaveLength(0);
		expect(graph.nodes.filter((node) => node.workItemId).map((node) => node.workItemId).sort())
			.toEqual(owners.map((agentClass) => `${agentClass}-work`).sort());
		expect(graph.nodes.find((node) => node.agentClass === 'reviewer')?.acceptanceCriteria).toHaveLength(6);
		expect(validateExecutionGraph(graph.nodes, graph.edges)).toMatchObject({ ok: true });
	});
	it('projects dependency-ordered planning and closing Reporter work', () => {
		const profiles = { 'sdk:architect': definition('architect'), 'sdk:engineer': definition('engineer', ['architect']),
			'sdk:reporter': definition('reporter') };
		const appliedPlan = compileWorkday({ id: 'workday', teamId: 'team', policyId: 'default', policyRevision: 1,
			executionMode: 'simulation',
			policy: { durationSeconds: 3600, maximumConcurrency: 2, planningTurnMaximumSeconds: 60,
				communicationConcurrency: 1, projectPercentages: { sdk: 100 }, agentClassPercentages: {} },
			agentIds: ['sdk/sdk/architect:planning', 'sdk/sdk/engineer:planning', 'sdk/sdk/reporter:planning'], startsAt: '2026-09-13T12:00:00.000Z' });
		const graph = projectActiveWorkdays({ teamId: 'team', revision: 1,
			sources: [{ id: 'workday', teamId: 'team', parameters: { appliedPlan, scheduledProjectIds: ['sdk'],
				agentProfilesByProjectId: { sdk: { revision: 'test', agents: Object.values(profiles).map((candidate) => ({ definition: candidate, activities: ['planning'] })) } } } }], profiles });
		expect(graph.nodes.filter((node) => node.kind === 'planning')).toHaveLength(3);
		expect(graph.nodes.map((node) => node.kind)).toEqual(expect.arrayContaining(['condition', 'reporting']));
		expect(graph.nodes.find((node) => node.kind === 'reporting')?.estimate)
			.toEqual({ minimumSeconds: 1, expectedSeconds: 5, maximumSeconds: 30 });
		expect(graph.nodes.find((node) => node.kind === 'reporting')?.requiredCapabilities)
			.toEqual(['treeseed.coordination.reporting']);
		expect(graph.nodes.filter((node) => node.kind === 'planning')
			.every((node) => node.requiredCapabilities?.[0] === 'treeseed.coordination.planning')).toBe(true);
		expect(graph.edges.some((edge) => edge.provenance === 'profile-agent'
			&& edge.fromNodeId.endsWith('sdk/architect:planning') && edge.toNodeId.endsWith('sdk/engineer:planning'))).toBe(true);
		expect(graph.edges.filter((edge) => edge.fromNodeId.startsWith('planning:workday:1:')
			&& edge.toNodeId.startsWith('planning:workday:2:'))).toHaveLength(0);
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
			activityTypes: ['estimating'],
			policy: { durationSeconds: 600, maximumConcurrency: 1, planningTurnMaximumSeconds: 60,
				communicationConcurrency: 1, projectPercentages: {}, agentClassPercentages: {} },
			agentIds: [participantId], startsAt: '2026-09-14T12:00:00.000Z' });
		const proposalRef = { store: 'treedx', model: 'proposal', id: 'golden-sdk', revision: 2,
			digest: `sha256:${'a'.repeat(64)}`, repository: 'sdk-library', commit: 'b'.repeat(40), path: 'proposals/golden-sdk.mdx' };
		const graph = projectActiveWorkdays({ teamId: 'team', revision: 1, profiles: { 'sdk:architect': architect },
			sources: [{ id: 'estimating-workday', teamId: 'team', proposalsByProjectId: { sdk: { executionPlan: { workItems: [{
				id: 'architecture-contract', agentClass: 'architect', review: 'required', acceptanceCriteria: ['Explain the one authority boundary.'],
			}] } } }, parameters: { appliedPlan, scheduledProjectIds: ['sdk'],
				agentSelection: { activityTypes: ['estimating'] },
				planningSourceByProjectId: { sdk: proposalRef },
				agentProfilesByProjectId: { sdk: { revision: 'test', agents: [{ definition: architect, activities: ['estimating'] }] } } } }] });
		expect(graph.nodes.filter((node) => node.kind === 'estimating')).toHaveLength(1);
		expect(graph.nodes.find((node) => node.kind === 'estimating')?.workItemId).toBe('architecture-contract');
		expect(graph.edges).toHaveLength(0);
		expect(graph.nodes.filter((node) => node.kind === 'estimating').every((node) =>
			node.requiredCapabilities?.[0] === 'treeseed.coordination.estimation')).toBe(true);
		expect(graph.nodes.some((node) => node.kind === 'planning')).toBe(false);
		expect(graph.nodes.filter((node) => node.kind === 'estimating').every((node) => node.sourceRef.id === 'golden-sdk'
			&& node.authorityRefs?.some((reference) => reference.model === 'workday'))).toBe(true);
	});

	it('does not manufacture subjectless planning rounds for a selected review activity', () => {
		const reviewer = definition('reviewer') as ReturnType<typeof definition> & { activityProfiles: Record<string, unknown> };
		reviewer.activityProfiles.reviewing = { handler: 'writer', permissions, prompt: { system: 'Review exact governed work.' } };
		const appliedPlan = compileWorkday({ id: 'review-workday', teamId: 'team', policyId: 'default', policyRevision: 1,
			executionMode: 'simulation',
			policy: { durationSeconds: 600, maximumConcurrency: 1, planningTurnMaximumSeconds: 60,
				communicationConcurrency: 1, projectPercentages: {}, agentClassPercentages: {} },
			agentIds: [], startsAt: '2026-09-14T12:00:00.000Z' });
		const graph = projectActiveWorkdays({ teamId: 'team', revision: 1, profiles: { 'sdk:reviewer': reviewer },
			sources: [{ id: 'review-workday', teamId: 'team', parameters: { appliedPlan, scheduledProjectIds: ['sdk'],
				agentSelection: { activityTypes: ['reviewing'] },
				agentProfilesByProjectId: { sdk: { revision: 'test', agents: [{ definition: reviewer, activities: ['reviewing'] }] } } } }] });
		expect(graph.nodes.filter((node) => node.kind === 'reviewing')).toHaveLength(0);
		expect(graph.nodes.filter((node) => node.kind === 'planning')).toHaveLength(0);
	});
});
