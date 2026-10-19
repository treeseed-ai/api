import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKDAY_POLICY, compileWorkday, appliedWorkdaySchema, validateExecutionGraph, type AgentDefinition } from '@treeseed/sdk/agent-capacity';
import { projectActiveWorkdays } from '../../../../../../src/api/capacity/policy/execution/workday-execution-projector.ts';
import { workdayParticipants } from '../../../../../../src/api/capacity/policy/execution/workday-participants.ts';

const permissions: NonNullable<AgentDefinition['activityProfiles']['planning']>['permissions'] = {
	content: { read: ['proposal'], write: ['proposal'] }, tools: ['discussion'],
};
const definition = (agentClass: string, dependsOn: string[] = []): AgentDefinition => ({
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
	it('accounts for only never-admitted obsolete estimator turns as cancelled in the original closing round', () => {
		const projectId='sdk',proposalId='ready-proposal';
		const agents=['engineer','reviewer'].map(agentClass=>{
			const agent=definition(agentClass);agent.activityProfiles.estimating={handler:'estimate',permissions,prompt:{system:'Estimate exact governed work.'}};
			return {definition:agent,activities:['estimating']};
		});
		const draft={id:proposalId,executionPlan:{workItems:[{id:'repair',agentClass:'engineer',review:'required'}]}};
		const snapshot={sdk:{agents}},participants=workdayParticipants({agentProfilesByProjectId:snapshot,proposalsByProjectId:{sdk:[draft]}});
		expect(participants).toHaveLength(2);
		const original=compileWorkday({id:'orphan',teamId:'team',policyId:'default',policyRevision:1,executionMode:'simulation',
			startsAt:'2026-10-19T09:00:00.000Z',policy:DEFAULT_WORKDAY_POLICY,agentIds:participants.map(p=>p.id)});
		const first=original.planningRounds[0]!;
		const second={round:2,state:'active' as const,assignmentIds:first.assignmentIds.map(id=>id.replace('planning:orphan:1:','planning:orphan:2:')),startedAt:'2026-10-19T09:03:00.000Z'};
		const plan={...original,state:'closing' as const,activatedAt:original.startsAt,closingAt:'2026-10-19T09:04:00.000Z',planningRounds:[
			{...first,state:'complete' as const,startedAt:original.startsAt,completedAt:'2026-10-19T09:02:00.000Z'},second]};
		const complete={...draft,executionPlan:{workItems:[{...draft.executionPlan.workItems[0]!,
			estimate:{expectedSeconds:120,maximumSeconds:180,rationale:'Controlled owning input.'},
			reviewEstimate:{expectedSeconds:60,maximumSeconds:90,rationale:'Controlled independent input.'}}]}};
		const reference={store:'treedx',model:'proposal',id:proposalId,revision:6,digest:'sha256:'+'a'.repeat(64),repository:'sdk-library',commit:'b'.repeat(40),path:'proposals/repair.mdx'};
		const source={id:plan.id,teamId:'team',proposalsByProjectId:{sdk:[complete]},proposalStatusesByProposalId:{[proposalId]:'accepted'},parameters:{appliedPlan:plan,
			scheduledProjectIds:[projectId],agentProfilesByProjectId:snapshot,planningSourceByProposalId:{[proposalId]:reference}}};
		const profiles=Object.fromEntries(agents.map(a=>['sdk:'+a.definition.agentClass,a.definition]));
		const historicReference={...reference,revision:2,commit:'c'.repeat(40)};
		const historicSource={...source,proposalsByProjectId:{sdk:[draft]},proposalStatusesByProposalId:{[proposalId]:'open'},parameters:{...source.parameters,
			planningSourceByProposalId:{[proposalId]:historicReference}}};
		const retainedNodes=projectActiveWorkdays({teamId:'team',revision:1,profiles,sources:[historicSource]}).nodes
			.filter(n=>first.assignmentIds.includes(n.id)).map(n=>({...n,status:'completed' as const}));
		expect(retainedNodes).toHaveLength(2);
		const input={teamId:'team',revision:8,profiles,sources:[source],retainedNodes,issuedNodeIds:first.assignmentIds};
		const held=structuredClone(input),graph=projectActiveWorkdays(input);
		expect(graph.nodes.map(n=>n.id).sort()).toEqual([...first.assignmentIds,...second.assignmentIds].sort());
		for(const prior of retainedNodes)expect(graph.nodes.find(n=>n.id===prior.id)).toEqual(prior);
		for(const node of graph.nodes.filter(n=>second.assignmentIds.includes(n.id))){expect(node).toMatchObject({kind:'estimating',status:'cancelled',workdayId:plan.id,sourceRef:reference});expect(node.authorityRefs).toHaveLength(1);expect(node.authorityRefs![0]).toMatchObject({store:'postgresql',model:'workday',id:plan.id});}
		expect(validateExecutionGraph(graph.nodes,graph.edges)).toMatchObject({ok:true});expect(input).toEqual(held);
		// Existing nodes OR original attempts must never be reclassified by recovery.
		expect(()=>projectActiveWorkdays({...input,issuedNodeIds:[...first.assignmentIds,...second.assignmentIds]})).toThrow('Missing original node for an issued planning turn');
		const {closingAt:_closingAt,...withoutClosing}=plan;
		const active={...source,parameters:{...source.parameters,appliedPlan:{...withoutClosing,state:'active' as const}}};
		expect(projectActiveWorkdays({...input,sources:[active]}).nodes).toEqual([]);
		const noSource={...source,proposalsByProjectId:{sdk:[]}};
		expect(projectActiveWorkdays({...input,sources:[noSource]}).nodes).toEqual([]);
	});

	it('admits a long governed proposal without exceeding the planning node ID bound', () => {
		const projectId = '8cbfb810-6da5-4da2-9ae9-cad53101253f';
		const proposalId = `golden-sdk-decision-governed-workday-intent-v4-${'f'.repeat(36)}`;
		const workdayId = `workday-${'a'.repeat(36)}`;
		const architect = definition('architect');
		architect.activityProfiles.estimating = { handler: 'estimate', permissions,
			prompt: { system: 'Estimate the exact proposal work.' } };
		const proposal = { id: proposalId, executionPlan: { workItems: [
			{ id: 'architecture-contract', agentClass: 'architect', review: 'required' },
		] } };
		const snapshot = { [projectId]: { agents: [{ definition: architect, activities: ['planning', 'estimating'] }] } };
		const participants = workdayParticipants({ agentProfilesByProjectId: snapshot,
			proposalsByProjectId: { [projectId]: [proposal] } });
		expect(participants).toHaveLength(2);
		expect(participants.find(item => item.activity === 'estimating')?.proposalId).toBe(proposalId);
		const plan = compileWorkday({ id: workdayId, teamId: 'team', policyId: 'default', policyRevision: 1,
			executionMode: 'simulation', agentIds: participants.map(item => item.id),
			startsAt: '2026-09-29T22:00:00Z', policy: { ...DEFAULT_WORKDAY_POLICY, durationSeconds: 3600,
				maximumConcurrency: 5, communicationConcurrency: 5 } });
		expect(plan.planningRounds[0]?.assignmentIds.every(id => id.length <= 200)).toBe(true);
		const graph = projectActiveWorkdays({ teamId: 'team', revision: 1,
			profiles: { 'sdk:architect': architect }, sources: [{ id: workdayId, teamId: 'team',
				proposalsByProjectId: { [projectId]: [proposal] }, parameters: { appliedPlan: plan,
					scheduledProjectIds: [projectId], agentProfilesByProjectId: snapshot,
					planningSourceByProposalId: { [proposalId]: { store: 'treedx', model: 'proposal',
						id: proposalId, revision: 1, repository: 'treeseed-ai/sdk-library',
						commit: 'b'.repeat(40), path: 'proposals/golden.mdx' } } } }] });
		expect(graph.nodes).toHaveLength(2);
		expect(graph.nodes.find(node => node.kind === 'estimating')?.sourceRef.id).toBe(proposalId);
		expect(validateExecutionGraph(graph.nodes, graph.edges)).toMatchObject({ ok: true });
	});
	it('keeps policy authority stable across operational accounting and repeated rounds', () => {
		const architect = definition('architect');
		const plan = compileWorkday({ id: 'stable', teamId: 'team', policyId: 'default', policyRevision: 1,
			executionMode: 'simulation', agentIds: ['sdk/sdk/architect:planning'], startsAt: '2026-09-16T12:00:00Z',
			policy: { ...DEFAULT_WORKDAY_POLICY, durationSeconds: 1800, maximumConcurrency: 1, communicationConcurrency: 1 } });
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
		expect(workdayParticipants({ ...parameters, agentSelection: { activityTypes: ['planning', 'estimating'] } })
			.map(participant => participant.activity)).toEqual(['planning', 'planning', 'planning']);
		const participants = workdayParticipants({ ...parameters, proposalsByProjectId: { sdk: [{ id: 'proposal', executionPlan: {
			workItems: [{ id: 'implementation', agentClass: 'engineer', review: 'required' }] } }] } });
		expect(participants.filter(participant => participant.activity === 'estimating').map(participant => participant.definition.agentClass))
			.toEqual(['engineer', 'reviewer']);
		expect(workdayParticipants({ ...parameters, proposalsByProjectId: { sdk: [{ id: 'proposal', executionPlan: {
			workItems: [{ id: 'implementation', agentClass: 'engineer', review: 'required',
				estimate: { expectedSeconds: 120, maximumSeconds: 180, rationale: 'Measured owner estimate.' },
				reviewEstimate: { expectedSeconds: 60, maximumSeconds: 90, rationale: 'Measured review estimate.' } }] } }] } })
			.filter(participant => participant.activity === 'estimating')).toEqual([]);
	});
	it('projects concurrent same-project proposal estimates against distinct exact sources', () => {
		const classes = ['architect', 'reviewer'];
		const profiles = Object.fromEntries(classes.map((agentClass) => {
			const agent = definition(agentClass) as ReturnType<typeof definition> & { activityProfiles: Record<string, unknown> };
			agent.activityProfiles.estimating = { handler: 'estimate', permissions, prompt: { system: 'Estimate exact work.' } };
			return [`sdk:${agentClass}`, agent];
		}));
		const ids = ['proposal-a', 'proposal-b'];
		const proposals = ids.map(id => ({ id, executionPlan: { workItems: [
			{ id: 'architecture', agentClass: 'architect', review: 'required' },
		] } }));
		const agentIds = workdayParticipants({ agentProfilesByProjectId: { sdk: { agents: Object.values(profiles)
			.map(definition => ({ definition, activities: ['estimating'] })) } },
			proposalsByProjectId: { sdk: proposals } }).map(participant => participant.id);
		expect(agentIds).toHaveLength(4);
		const appliedPlan = compileWorkday({ id: 'parallel-proposals', teamId: 'team', policyId: 'default', policyRevision: 1,
			executionMode: 'simulation', agentIds, startsAt: '2026-09-29T12:00:00.000Z',
			policy: { ...DEFAULT_WORKDAY_POLICY, durationSeconds: 3600, maximumConcurrency: 5, communicationConcurrency: 5 } });
		const refs = Object.fromEntries(ids.map(id => [id, { store: 'treedx', model: 'proposal', id,
			revision: 1, repository: 'sdk-library', commit: 'b'.repeat(40), path: `proposals/${id}.mdx` }]));
		const graph = projectActiveWorkdays({ teamId: 'team', revision: 1, profiles, sources: [{
			id: appliedPlan.id, teamId: 'team', proposalsByProjectId: { sdk: proposals }, parameters: {
				appliedPlan, scheduledProjectIds: ['sdk'], planningSourceByProposalId: refs,
				agentProfilesByProjectId: { sdk: { agents: Object.values(profiles)
					.map(definition => ({ definition, activities: ['estimating'] })) } },
			},
		}] });
		expect(graph.nodes.filter(node => node.kind === 'estimating')).toHaveLength(4);
		for (const id of ids) expect(graph.nodes.filter(node => node.sourceRef.id === id)).toHaveLength(2);
		for (const edge of graph.edges) {
			const from = graph.nodes.find(node => node.id === edge.fromNodeId)!;
			const to = graph.nodes.find(node => node.id === edge.toNodeId)!;
			expect(from.sourceRef.id).toBe(to.sourceRef.id);
		}
	});
	it('projects estimates only for missing owner and reviewer measurements', () => {
		const classes = ['architect', 'engineer', 'reviewer'];
		const profiles = Object.fromEntries(classes.map((agentClass) => {
			const agent = definition(agentClass) as ReturnType<typeof definition> & { activityProfiles: Record<string, unknown> };
			agent.activityProfiles.estimating = { handler: 'estimate', permissions, prompt: { system: 'Estimate exact work.' },
				...(agentClass === 'engineer' ? { dependsOn: { agents: ['architect'] } } : {}) };
			return [`sdk:${agentClass}`, agent];
		}));
		const appliedPlan = compileWorkday({ id: 'missing-estimates', teamId: 'team', policyId: 'default', policyRevision: 1,
			executionMode: 'simulation', policy: { ...DEFAULT_WORKDAY_POLICY, durationSeconds: 1800, maximumConcurrency: 1,
				planningTurnMaximumSeconds: 60, communicationConcurrency: 1, projectPercentages: {}, agentClassPercentages: {} },
			agentIds: classes.map((agentClass) => `sdk/sdk/${agentClass}:estimating:proposal`), startsAt: '2026-09-14T12:00:00.000Z' });
		const estimate = { expectedSeconds: 120, maximumSeconds: 180, rationale: 'Existing exact estimate.' };
		const graph = projectActiveWorkdays({ teamId: 'team', revision: 1, profiles, sources: [{ id: appliedPlan.id,
			teamId: 'team', proposalsByProjectId: { sdk: [{ id: 'proposal', executionPlan: { workItems: [
				{ id: 'architecture', agentClass: 'architect', review: 'required', estimate },
				{ id: 'implementation', agentClass: 'engineer', review: 'required', reviewEstimate: estimate },
			] } }] }, parameters: { appliedPlan, scheduledProjectIds: ['sdk'],
				planningSourceByProposalId: { proposal: { store: 'treedx', model: 'proposal', id: 'proposal', revision: 1,
					repository: 'sdk-library', commit: 'b'.repeat(40), path: 'proposals/golden.mdx' } },
				agentProfilesByProjectId: { sdk: { agents: Object.values(profiles).map((agent) => ({ definition: agent,
					activities: ['estimating'] })) } } } }] });
		expect(graph.nodes.filter((node) => node.kind === 'estimating').map((node) => node.agentClass).sort())
			.toEqual(['engineer', 'reviewer']);
		expect(graph.nodes.find((node) => node.agentClass === 'engineer')?.acceptanceCriteria)
			.toContain('Estimate work item implementation: expectedSeconds, maximumSeconds, and rationale.');
		expect(graph.nodes.find((node) => node.agentClass === 'reviewer')?.acceptanceCriteria)
			.toEqual(['Estimate the generated review of work item architecture independently: expectedSeconds, maximumSeconds, and rationale.']);
	});
	it('projects six work-owner contributions, including multiple items for Engineer, and one Reviewer', () => {
		const owners = ['researcher', 'architect', 'tester', 'engineer', 'technical-writer', 'releaser'];
		const classes = [...owners, 'reviewer'];
		const profiles = Object.fromEntries(classes.map((agentClass) => {
			const agent = definition(agentClass) as ReturnType<typeof definition> & { activityProfiles: Record<string, unknown> };
			agent.activityProfiles.estimating = { handler: 'estimate', permissions, prompt: { system: 'Estimate the exact proposal work.' } };
			return [`sdk:${agentClass}`, agent];
		}));
		const appliedPlan = compileWorkday({ id: 'seven-estimates', teamId: 'team', policyId: 'default', policyRevision: 1,
			executionMode: 'simulation', activityTypes: ['estimating'],
			policy: { ...DEFAULT_WORKDAY_POLICY, durationSeconds: 1800, maximumConcurrency: 1, planningTurnMaximumSeconds: 60,
				communicationConcurrency: 1, projectPercentages: {}, agentClassPercentages: {} },
			agentIds: classes.map((agentClass) => `sdk/sdk/${agentClass}:estimating:proposal`), startsAt: '2026-09-14T12:00:00.000Z' });
		const projectionInput: Parameters<typeof projectActiveWorkdays>[0] = { teamId: 'team', revision: 1, profiles,
			sources: [{ id: 'seven-estimates', teamId: 'team', proposalsByProjectId: { sdk: [{ id: 'proposal', executionPlan: {
				workItems: [...owners.map((agentClass) => ({ id: `${agentClass}-work`, agentClass, review: 'required', acceptanceCriteria: ['Meet the exact work-item boundary.'] })),
					{ id: 'engineer-integration', agentClass: 'engineer', review: 'required', acceptanceCriteria: ['Integrate the implementation.'] }],
			} }] }, parameters: { appliedPlan, scheduledProjectIds: ['sdk'],
				planningSourceByProposalId: { proposal: { store: 'treedx', model: 'proposal', id: 'proposal', revision: 1,
					repository: 'sdk-library', commit: 'b'.repeat(40), path: 'proposals/golden.mdx' } },
				agentProfilesByProjectId: { sdk: { agents: Object.values(profiles).map((agent) => ({ definition: agent, activities: ['estimating'] })) } },
			} }] };
		const graph = projectActiveWorkdays(projectionInput);
		expect(graph.nodes).toHaveLength(7);
		expect(graph.edges).toHaveLength(6);
		expect(graph.edges.filter((edge) => edge.toNodeId.endsWith('sdk/reviewer:estimating:proposal'))
			.map((edge) => edge.fromNodeId).sort()).toEqual(owners.map((owner) =>
			`planning:seven-estimates:1:sdk/sdk/${owner}:estimating:proposal`).sort());
		expect(graph.nodes.filter((node) => node.kind === 'estimating' && node.agentClass !== 'engineer'
			&& node.agentClass !== 'reviewer').every((node) => node.workItemId === `${node.agentClass}-work`)).toBe(true);
		expect(graph.nodes.find((node) => node.agentClass === 'engineer')?.workItemId).toBeUndefined();
		for (const agentClass of owners) expect(graph.nodes.find((node) => node.agentClass === agentClass)?.acceptanceCriteria)
			.toContain(`Estimate work item ${agentClass}-work: expectedSeconds, maximumSeconds, and rationale.`);
		expect(graph.nodes.find((node) => node.agentClass === 'engineer')?.acceptanceCriteria)
			.toContain('Estimate work item engineer-integration: expectedSeconds, maximumSeconds, and rationale.');
		expect(graph.nodes.find((node) => node.agentClass === 'reviewer')?.acceptanceCriteria).toHaveLength(7);
		expect(validateExecutionGraph(graph.nodes, graph.edges)).toMatchObject({ ok: true });
		const accepted = projectActiveWorkdays({ ...projectionInput,
			sources: projectionInput.sources.map((source) => ({ ...source,
				proposalStatusesByProposalId: { proposal: 'accepted' } })) });
		expect(accepted.nodes.filter((node) => node.kind === 'estimating'))
			.toHaveLength(7);
		expect(accepted.nodes.every((node) => node.status === 'cancelled')).toBe(true);
		expect(validateExecutionGraph(accepted.nodes, accepted.edges)).toMatchObject({ ok: true });
	});
	it('projects dependency-ordered planning and closing Reporter work', () => {
		const profiles = { 'sdk:architect': definition('architect'), 'sdk:engineer': definition('engineer', ['architect']),
			'sdk:reporter': definition('reporter') };
		const appliedPlan = compileWorkday({ id: 'workday', teamId: 'team', policyId: 'default', policyRevision: 1,
			executionMode: 'simulation',
			policy: { ...DEFAULT_WORKDAY_POLICY, durationSeconds: 3600, maximumConcurrency: 2, planningTurnMaximumSeconds: 60,
				communicationConcurrency: 1, projectPercentages: { sdk: 100 }, agentClassPercentages: {} },
			agentIds: ['sdk/sdk/architect:planning', 'sdk/sdk/engineer:planning', 'sdk/sdk/reporter:planning'], startsAt: '2026-09-13T12:00:00.000Z' });
		const graph = projectActiveWorkdays({ teamId: 'team', revision: 1,
			sources: [{ id: 'workday', teamId: 'team', parameters: { appliedPlan, scheduledProjectIds: ['sdk'],
				agentProfilesByProjectId: { sdk: { revision: 'test', agents: Object.values(profiles).map((candidate) => ({ definition: candidate, activities: ['planning'] })) } } } }], profiles });
		expect(graph.nodes.filter((node) => node.kind === 'planning')).toHaveLength(3);
		expect(graph.nodes.map((node) => node.kind)).toEqual(expect.arrayContaining(['condition', 'reporting']));
		expect(graph.nodes.find((node) => node.kind === 'reporting')?.estimate)
			.toEqual({ expectedSeconds: 5, maximumSeconds: 30 });
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

	it('lets Reporter close the workday while selected decision work carries forward', () => {
		const reporter = definition('reporter');
		const plan = compileWorkday({ id: 'decision-workday', teamId: 'team', policyId: 'default', policyRevision: 1,
			executionMode: 'simulation', policy: { ...DEFAULT_WORKDAY_POLICY, durationSeconds: 900, maximumConcurrency: 1,
				communicationConcurrency: 1, projectPercentages: { sdk: 100 }, agentClassPercentages: {} },
			agentIds: [], startsAt: '2026-09-22T12:00:00.000Z' });
		const decision = { store: 'postgresql' as const, model: 'decision' as const, id: 'decision-1', revision: 1,
			digest: `sha256:${'a'.repeat(64)}` };
		const base = { schemaVersion: 'treeseed.execution-node/v1' as const, teamId: 'team', projectId: 'sdk',
			sourceRef: decision, authorityRefs: [decision], ruleRevision: 1, nodeRevision: 1,
			status: 'blocked' as const, graphRevisionCreated: 1, graphRevisionUpdated: 1 };
		const actor = { ...base, id: 'actor', kind: 'acting' as const, pairRole: 'actor' as const,
			workItemId: 'release', agentClass: 'releaser', maximumReviewCycles: 2 };
		const reviewer = { ...base, id: 'reviewer', kind: 'reviewing' as const, pairRole: 'reviewer' as const,
			workItemId: 'release', agentClass: 'reviewer', maximumReviewCycles: 2 };
		const graph = projectActiveWorkdays({ teamId: 'team', revision: 1,
			sources: [{ id: plan.id, teamId: 'team', parameters: { appliedPlan: { ...plan, state: 'closing',
				closingAt: '2026-09-22T12:15:00.000Z' }, scheduledProjectIds: ['sdk'], decisionIds: ['decision-1'] } }],
			profiles: { 'sdk:reporter': reporter }, decisionNodes: [actor, reviewer] });
		const condition = graph.nodes.find((node) => node.kind === 'condition')!;
		expect(graph.edges.filter((candidate) => candidate.toNodeId === condition.id).map((candidate) => candidate.fromNodeId))
			.toEqual([]);
		expect(graph.edges.filter((candidate) => candidate.fromNodeId === condition.id).map((candidate) => candidate.toNodeId))
			.toEqual([`reporting:${plan.id}:sdk/sdk/reporter`]);
	});

	it('projects an explicitly selected estimating profile without falling back to planning', () => {
		const architect = definition('architect') as ReturnType<typeof definition> & { activityProfiles: Record<string, unknown> };
		architect.activityProfiles.estimating = { handler: 'estimate', permissions, prompt: { system: 'Estimate exact work.' } };
		const participantId = 'sdk/sdk/architect:estimating:golden-sdk';
		const appliedPlan = compileWorkday({ id: 'estimating-workday', teamId: 'team', policyId: 'default', policyRevision: 1,
			executionMode: 'simulation',
			activityTypes: ['estimating'],
			policy: { ...DEFAULT_WORKDAY_POLICY, durationSeconds: 600, maximumConcurrency: 1, planningTurnMaximumSeconds: 60,
				communicationConcurrency: 1, projectPercentages: {}, agentClassPercentages: {} },
			agentIds: [participantId], startsAt: '2026-09-14T12:00:00.000Z' });
		const proposalRef = { store: 'treedx', model: 'proposal', id: 'golden-sdk', revision: 2,
			digest: `sha256:${'a'.repeat(64)}`, repository: 'sdk-library', commit: 'b'.repeat(40), path: 'proposals/golden-sdk.mdx' };
		const graph = projectActiveWorkdays({ teamId: 'team', revision: 1, profiles: { 'sdk:architect': architect },
			sources: [{ id: 'estimating-workday', teamId: 'team', proposalsByProjectId: { sdk: [{ id: 'golden-sdk', executionPlan: { workItems: [{
				id: 'architecture-contract', agentClass: 'architect', review: 'required', acceptanceCriteria: ['Explain the one authority boundary.'],
			}] } }] }, parameters: { appliedPlan, scheduledProjectIds: ['sdk'],
				agentSelection: { activityTypes: ['estimating'] },
				planningSourceByProposalId: { 'golden-sdk': proposalRef },
				agentProfilesByProjectId: { sdk: { revision: 'test', agents: [{ definition: architect, activities: ['estimating'] }] } } } }] });
		expect(graph.nodes.filter((node) => node.kind === 'estimating')).toHaveLength(1);
		expect(graph.nodes.find((node) => node.kind === 'estimating')?.workItemId).toBe('architecture-contract');
		expect(graph.nodes.find((node) => node.kind === 'estimating')?.acceptanceCriteria)
			.toContain('Estimate work item architecture-contract: expectedSeconds, maximumSeconds, and rationale.');
		expect(graph.edges).toHaveLength(0);
		expect(graph.nodes.filter((node) => node.kind === 'estimating').every((node) =>
			node.requiredCapabilities?.[0] === 'treeseed.coordination.estimation')).toBe(true);
		expect(graph.nodes.some((node) => node.kind === 'planning')).toBe(false);
		expect(graph.nodes.filter((node) => node.kind === 'estimating').every((node) => node.sourceRef.id === 'golden-sdk'
			&& node.authorityRefs?.some((reference) => reference.model === 'workday'))).toBe(true);
	});
	it('allows an owner estimate after its own planning turn without waiting for unrelated agents', () => {
		for (const proposalId of ['proposal', 'proposal:section']) {
		const classes = ['architect', 'researcher', 'reviewer'];
		const profiles = Object.fromEntries(classes.map(agentClass => {
			const agent = definition(agentClass) as ReturnType<typeof definition> & { activityProfiles: Record<string, unknown> };
			agent.activityProfiles.estimating = { handler: 'estimate', permissions, prompt: { system: 'Estimate exact work.' } };
			return [`sdk:${agentClass}`, agent];
		}));
		const appliedPlan = compileWorkday({ id: 'parallel-estimates', teamId: 'team', policyId: 'default', policyRevision: 1,
			executionMode: 'simulation', policy: { ...DEFAULT_WORKDAY_POLICY, durationSeconds: 3600, maximumConcurrency: 5,
				planningTurnMaximumSeconds: 180, communicationConcurrency: 5 },
			agentIds: classes.flatMap(agentClass => [`sdk/sdk/${agentClass}:planning`, `sdk/sdk/${agentClass}:estimating:${proposalId}`]),
			startsAt: '2026-09-28T10:00:00.000Z' });
		const graph = projectActiveWorkdays({ teamId: 'team', revision: 1, profiles,
			sources: [{ id: appliedPlan.id, teamId: 'team', proposalsByProjectId: { sdk: [{ id: proposalId, executionPlan: { workItems: [
				{ id: 'architecture', agentClass: 'architect', review: 'required' },
				{ id: 'research', agentClass: 'researcher', review: 'required' },
			] } }] }, parameters: { appliedPlan, scheduledProjectIds: ['sdk'],
				agentProfilesByProjectId: { sdk: { agents: Object.values(profiles).map(agent => ({ definition: agent,
					activities: ['planning', 'estimating'] })) } } } }] });
		expect(graph.nodes.filter(node => node.kind === 'estimating')).toHaveLength(3);
		const incoming = (agentClass: string) => graph.edges.filter(edge => edge.toNodeId.endsWith(`sdk/${agentClass}:estimating:${proposalId}`))
			.map(edge => edge.fromNodeId).sort();
		expect(incoming('architect')).toEqual(['planning:parallel-estimates:1:sdk/sdk/architect:planning']);
		expect(incoming('researcher')).toEqual(['planning:parallel-estimates:1:sdk/sdk/researcher:planning']);
		expect(incoming('reviewer')).toEqual([
			`planning:parallel-estimates:1:sdk/sdk/architect:estimating:${proposalId}`,
			`planning:parallel-estimates:1:sdk/sdk/researcher:estimating:${proposalId}`,
			'planning:parallel-estimates:1:sdk/sdk/reviewer:planning',
		]);
		expect(validateExecutionGraph(graph.nodes, graph.edges)).toMatchObject({ ok: true });
		}
	});

	it('does not manufacture subjectless planning rounds for a selected review activity', () => {
		const reviewer = definition('reviewer') as ReturnType<typeof definition> & { activityProfiles: Record<string, unknown> };
		reviewer.activityProfiles.reviewing = { handler: 'writer', permissions, prompt: { system: 'Review exact governed work.' } };
		const appliedPlan = compileWorkday({ id: 'review-workday', teamId: 'team', policyId: 'default', policyRevision: 1,
			executionMode: 'simulation',
			policy: { ...DEFAULT_WORKDAY_POLICY, durationSeconds: 600, maximumConcurrency: 1, planningTurnMaximumSeconds: 60,
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

function explicitReportingSelection(){
 const selected={...definition('reporter'),id:'sdk/digest-writer',agentClass:'digest-writer'},other={...definition('reporter'),id:'api/digest-writer',agentClass:'digest-writer'};
 const snapshot={sdk:{agents:[{definition:selected,activities:['planning']}]},api:{agents:[{definition:other,activities:['planning']}]}},participants=workdayParticipants({agentProfilesByProjectId:snapshot});
 // Proposed necessary canonical contract input; current compileWorkday drops it.
 const input={id:'one-configured-closeout',teamId:'team',policyId:'default',policyRevision:1,executionMode:'simulation' as const,startsAt:'2026-10-17T00:00:00.000Z',agentIds:participants.map(value=>value.id),reportingAgentId:selected.id,policy:{...DEFAULT_WORKDAY_POLICY,durationSeconds:3600,maximumConcurrency:5,communicationConcurrency:5}};
 return{selected,other,snapshot,input,plan:compileWorkday(input)};
}

it('retains one explicitly selected configured Reporter in the canonical applied Workday before activation without a second authority',()=>{
 const f=explicitReportingSelection(),held=structuredClone(f.input);expect.soft(f.plan).toMatchObject({state:'planned',reportingAgentId:f.selected.id});expect.soft(appliedWorkdaySchema.safeParse({...f.plan,reportingAgentId:f.selected.id}).success).toBe(true);expect(f.input).toEqual(held);
});

it('projects only the selected configured closeout Reporter while preserving every participating project planning contributor',()=>{
 const f=explicitReportingSelection(),source={id:f.plan.id,teamId:'team',parameters:{appliedPlan:f.plan,scheduledProjectIds:['sdk','api'],agentProfilesByProjectId:f.snapshot}},held=structuredClone(source);
 const projected=projectActiveWorkdays({teamId:'team',revision:1,profiles:{'sdk:digest-writer':f.selected,'api:digest-writer':f.other},sources:[source]});
 expect.soft(projected.nodes.filter(node=>node.kind==='planning').map(node=>node.projectId).sort()).toEqual(['api','sdk']);expect.soft(projected.nodes.filter(node=>node.kind==='reporting')).toHaveLength(1);expect.soft(projected.nodes.filter(node=>node.kind==='reporting').map(node=>node.projectId)).toEqual(['sdk']);expect(source).toEqual(held);
});

it('denies omitted ambiguous foreign duplicate and moved reporting authority without replacing the captured selection',()=>{
 const f=explicitReportingSelection(),profiles={'sdk:digest-writer':f.selected,'api:digest-writer':f.other},parameters={appliedPlan:f.plan,scheduledProjectIds:['sdk','api'],agentProfilesByProjectId:f.snapshot};
 for(const reportingAgentId of [undefined,'foreign/digest-writer','sdk/missing']) {
  const plan={...f.plan};delete plan.reportingAgentId;Object.assign(plan,reportingAgentId===undefined?{}:{reportingAgentId});
  const source={id:plan.id,teamId:'team',parameters:{...parameters,appliedPlan:plan}},held=structuredClone(source);
  expect(()=>projectActiveWorkdays({teamId:'team',revision:1,profiles,sources:[source]})).toThrow();expect(source).toEqual(held);
 }
 const duplicate={...f.other,id:f.selected.id};
 expect(()=>projectActiveWorkdays({teamId:'team',revision:1,profiles:{...profiles,'api:digest-writer':duplicate},sources:[{id:f.plan.id,teamId:'team',parameters}]})).toThrow();
 const moved={...f.selected,purpose:'Changed after frozen selection.'};
 expect(()=>projectActiveWorkdays({teamId:'team',revision:1,profiles:{...profiles,'sdk:digest-writer':moved},sources:[{id:f.plan.id,teamId:'team',parameters}]})).toThrow();
 const original=projectActiveWorkdays({teamId:'team',revision:1,profiles,sources:[{id:f.plan.id,teamId:'team',parameters}]}),changed=projectActiveWorkdays({teamId:'team',revision:1,profiles,sources:[{id:f.plan.id,teamId:'team',parameters:{...parameters,appliedPlan:{...f.plan,reportingAgentId:f.other.id}}}]} );
 expect(changed.changedSourceRefs).not.toEqual(original.changedSourceRefs);
 expect(changed.nodes.filter(node=>node.kind==='reporting').map(node=>node.projectId)).toEqual(['api']);
});
