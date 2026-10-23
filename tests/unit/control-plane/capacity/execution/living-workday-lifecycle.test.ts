import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-content-readback.ts', () => ({
	reconcileAssignmentContent: vi.fn(async () => undefined),
}));
import { advanceLivingWorkday } from '../../../../../src/api/capacity/services/capacity/workdays/lifecycle/living-workday-lifecycle.ts';
import { DEFAULT_WORKDAY_POLICY, appliedWorkdaySchema, compileWorkday, validateAgentDefinitionModel } from '@treeseed/sdk/agent-capacity';
import { runtimeWorkdayPhase } from '../../../../../src/api/capacity/services/build/ready-execution-node.ts';
import { compileCapacityWorkdayRunRecord } from '../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-run-service.ts';
import { readExactProposal } from '../../../../../src/api/governance/executable-proposal.ts';
const contributionProof = vi.hoisted(() => vi.fn());
vi.mock('../../../../../src/api/capacity/services/capacity/execution/proposal-contributions.ts', () => ({ loadProposalGroupContributions: contributionProof }));
beforeEach(() => {
	// Controlled cohort boundary input, not model evidence.
	contributionProof.mockReset().mockImplementation(async (_store, proposal) => ({
		current: ['ready', 'revised'].includes(proposal.id), attempts: [], missing: [] }));
});

const fluidPlan = { ...compileWorkday({ id: 'fluid-workday', teamId: 'team', policyId: 'default', policyRevision: 1,
	executionMode: 'simulation', policy: { ...DEFAULT_WORKDAY_POLICY, durationSeconds: 3600, planningPercent: 100 / 3,
		maximumConcurrency: 5, communicationConcurrency: 5 }, agentIds: [],
	startsAt: '2026-09-29T12:00:00Z' }), state: 'active' as const };
const fluidRun = compileCapacityWorkdayRunRecord('team', { id: 'fluid-workday', executionMode: 'simulation',
	parameters: { appliedPlan: fluidPlan, scheduledProjectIds: ['sdk', 'api'] } });

describe('fluid workday phase from the living graph', () => {
	it('keeps the initial planning window even if approved work is ready', async () => {
		const first = vi.fn(async () => ({ id: 'actor' }));
		expect(await runtimeWorkdayPhase({ first } as never, fluidRun, '2026-09-29T12:19:59Z')).toBe('planning');
		expect(first).not.toHaveBeenCalled();
	});
	it('continues or resumes planning when no approved acting node is ready', async () => {
		const first = vi.fn(async () => null);
		expect(await runtimeWorkdayPhase({ first } as never, fluidRun, '2026-09-29T12:20:00Z')).toBe('planning');
		expect(first).toHaveBeenCalledOnce();
	});
	it('admits acting only when a ready node exists in selected projects', async () => {
		const first = vi.fn(async (_sql: string) => ({ id: 'actor' }));
		expect(await runtimeWorkdayPhase({ first } as never, fluidRun, '2026-09-29T12:20:00Z')).toBe('acting');
		expect(first.mock.calls[0]?.[0]).toContain("node.kind IN ('acting','reviewing')");
	});
	it('never revives a workday after its hard end', async () => {
		const first = vi.fn(async () => ({ id: 'actor' }));
		expect(await runtimeWorkdayPhase({ first } as never, fluidRun, fluidPlan.endsAt)).toBe('ended');
		expect(first).not.toHaveBeenCalled();
	});
});

vi.mock('../../../../../src/api/governance/executable-proposal.ts', async (importOriginal) => ({
	...await importOriginal<typeof import('../../../../../src/api/governance/executable-proposal.ts')>(),
	readExactProposal: vi.fn(async (_store: unknown, proposal: { id?: string }) => {
		if (proposal.id === 'incomplete') throw Object.assign(new Error('Proposal has no executable plan.'),
			{ code: 'proposal_execution_plan_invalid' });
		return { ref: { store: 'treedx', model: 'proposal', id: proposal.id, revision: 1,
		digest: `sha256:${'a'.repeat(64)}`, repository: 'project-library', commit: 'b'.repeat(40), path: 'proposals/new.mdx' },
		definition: { schemaVersion: 'treeseed.proposal/v2', id: proposal.id, groupIds: ['portfolio'],
			status: proposal.id === 'ready' ? 'ready' : proposal.id === 'revised' ? 'discussing' : 'draft',
			executionPlan: { workItems: [{ id: 'research', review: 'required',
				...(proposal.id === 'ready' || proposal.id === 'revised' ? {
					estimate: { expectedSeconds: 30, maximumSeconds: 60 },
					reviewEstimate: { expectedSeconds: 10, maximumSeconds: 20 },
				} : {}) }] } } };
	}),
}));

const now = '2026-09-13T16:00:00.000Z';
const policy = { ...DEFAULT_WORKDAY_POLICY, durationSeconds: 60, maximumConcurrency: 2, planningTurnMaximumSeconds: 10,
	communicationConcurrency: 1, projectPercentages: { project: 100 }, agentClassPercentages: { project: { architect: 100 } } };
const planningPermissions = { content: { read: ['proposal'], write: ['proposal'] }, tools: ['discussion'] };
const planningAgent = (agentClass: string) => ({ schemaVersion: 'treeseed.agent/v1', id: `project/${agentClass}`,
	name: agentClass, agentClass: 'maintenance', groupIds: ['portfolio'], purpose: 'Estimate governed work.', responsibilities: ['Return exact results.'],
	capabilities: ['reasoning'], context: { include: ['project-objectives'] }, activityProfiles: {
		planning: { handler: 'writer', permissions: planningPermissions, prompt: { system: 'Plan useful governed work for this project.' } },
		estimating: { handler: 'estimate', permissions: planningPermissions, prompt: { system: 'Estimate exact proposal work for this project.' } },
	} });
const plan = { schemaVersion: 'treeseed.workday/v1', id: 'workday', teamId: 'team', policyId: 'default', policyRevision: 1,
	executionMode: 'simulation',
	policySnapshot: policy, state: 'active', startsAt: '2026-09-13T15:00:00.000Z', endsAt: '2026-09-13T15:01:00.000Z',
	planningRounds: [{ round: 1, state: 'active', assignmentIds: ['planning:workday:1:project/architect:planning'] },
		{ round: 2, state: 'pending', assignmentIds: ['planning:workday:2:project/architect:planning'] }],
	admittedSecondsByProject: {}, admittedSecondsByAgentClass: {}, activatedAt: '2026-09-13T15:00:00.000Z' } as const;
const run = compileCapacityWorkdayRunRecord('team', { id: 'workday', status: 'running', executionMode: 'simulation',
	startedAt: plan.startsAt, parameters: { durationSeconds: 60, appliedPlan: plan } }, { now });
const reportReference = { kind: 'treedx', projectId: 'project', repository: 'team-library',
	commit: 'a'.repeat(40), path: 'notes/report.mdx', workspaceId: 'workspace' };
const reportResult = { schemaVersion: 'treeseed.assignment-result/v1', id: 'result', assignmentId: 'assignment',
	status: 'completed', summary: 'Recorded report.', references: [reportReference], verification: [],
	usage: { elapsedSeconds: 1 }, diagnostics: [], completedAt: now };

describe('living workday lifecycle', () => {
	it.each(['missing-group', 'legacy-class', 'other-group'])('does not create a new scoped round from %s authority', async condition => {
		const proposal = { id: 'not-admitted', schemaVersion: condition === 'legacy-class' ? 'treeseed.proposal/v1' : 'treeseed.proposal/v2',
			groupIds: [condition === 'other-group' ? 'elsewhere' : 'portfolio'], executionPlan: { workItems: [{ id: 'old', agentClass: 'maintenance' }] } };
		vi.mocked(readExactProposal).mockResolvedValueOnce({ definition: proposal,
			ref: { store: 'treedx', model: 'proposal', id: proposal.id, revision: 1 } } as never);
		const currentPlan = { ...plan, endsAt: '2026-09-13T16:00:00Z', policySnapshot: { ...policy, durationSeconds: 3600, planningPercent: 20 } };
		const currentRun = { ...run, parameters: { appliedPlan: currentPlan, scheduledProjectIds: ['project'], proposalIds: [proposal.id],
			groupIds: condition === 'missing-group' ? [] : ['portfolio'], agentProfilesByProjectId: { project: { agents: [
				{ definition: planningAgent('author'), activities: ['planning', 'estimating'] }] } } } };
		const store = { all: async (sql: string) => sql.includes('FROM governance_proposals') ? [{ id: proposal.id }]
			: currentPlan.planningRounds.flatMap(round => round.assignmentIds.map(id => ({ id, kind: 'planning', status: 'completed' }))),
			updateCapacityWorkdayRun: vi.fn(async () => currentRun) };
		const result = await advanceLivingWorkday(store as never, currentRun as never, '2026-09-13T15:03:00Z');
		expect(result.plan.planningRounds).toHaveLength(2);
		expect(result.plan.planningRounds.map(round => round.assignmentIds)).toEqual(currentPlan.planningRounds.map(round => round.assignmentIds));
		expect(result.plan.endsAt).toBe(currentPlan.endsAt);
		expect(contributionProof).not.toHaveBeenCalled();
	});
	it('rebuilds later rounds from current group contributions instead of initial planning ID suffixes', async () => {
		contributionProof.mockResolvedValueOnce({ current: false, attempts: [], missing: ['project/project/author'] });
		const proposal = { schemaVersion: 'treeseed.proposal/v2', id: 'group-repair', groupIds: ['portfolio'], status: 'discussing' };
		vi.mocked(readExactProposal).mockResolvedValueOnce({ definition: proposal, ref: {
			store: 'treedx', model: 'proposal', id: proposal.id, revision: 2, digest: `sha256:${'a'.repeat(64)}`,
			repository: 'project-library', commit: 'b'.repeat(40), path: 'proposals/group-repair.mdx' } } as never);
		const definition = { ...planningAgent('maintenance'), id: 'project/author', name: 'Author', groupIds: ['portfolio'] };
		const identities = ['planning', 'estimating'].map(activity => `project/project/author:${activity}:group-repair`);
		const currentPlan = { ...plan, endsAt: '2026-09-13T16:00:00Z',
			policySnapshot: { ...policy, durationSeconds: 3600, planningPercent: 20 },
			planningRounds: [{ round: 1, state: 'active', assignmentIds: identities.map(id => `planning:workday:1:${id}`) }] };
		const currentRun = { ...run, parameters: { appliedPlan: currentPlan, scheduledProjectIds: ['project'],
			proposalIds: [proposal.id], groupIds: ['portfolio'],
			agentProfilesByProjectId: { project: { agents: [{ definition, activities: ['planning', 'estimating'] }] } } } };
		const store = { first: async () => null, all: async (sql: string) => sql.includes('FROM governance_proposals')
			? [{ id: proposal.id, team_id: 'team', project_id: 'project' }]
			: currentPlan.planningRounds.flatMap(round => round.assignmentIds.map(id => ({ id, kind: 'planning', status: 'completed' }))),
			updateCapacityWorkdayRun: vi.fn(async () => currentRun) };
		const next = await advanceLivingWorkday(store as never, currentRun as never, '2026-09-13T15:03:00Z');
		expect(next.plan.planningRounds.at(-1)!.assignmentIds).toEqual(identities.sort().map(id => `planning:workday:2:${id}`));
		expect(next.plan.planningRounds[0]!.assignmentIds).toEqual(currentPlan.planningRounds[0]!.assignmentIds);
		expect(next.plan.endsAt).toBe(currentPlan.endsAt);
	});
	it('continues group estimating after the first structurally complete contribution until the shared cohort reader verifies everyone', async () => {
		const partial = { schemaVersion: 'treeseed.proposal/v2', id: 'partial-group', groupIds: ['portfolio'], status: 'discussing',
			executionPlan: { workItems: [{ id: 'document-runner', estimate: { expectedSeconds: 30, maximumSeconds: 60 },
				review: 'required', reviewEstimate: { expectedSeconds: 20, maximumSeconds: 40 } }] } };
		const agents = ['technical-writer', 'tester'].map(name => ({ definition: { ...planningAgent('maintenance'),
			id: `project/${name}`, name, groupIds: ['portfolio'] }, activities: ['estimating'] }));
		for (const current of [false, true]) {
			contributionProof.mockResolvedValue({ current, attempts: [], missing: current ? [] : ['project/project/tester'] });
			vi.mocked(readExactProposal).mockResolvedValueOnce({ definition: partial, ref: {
				store: 'treedx', model: 'proposal', id: partial.id, revision: 2, digest: `sha256:${'a'.repeat(64)}`,
				repository: 'project-library', commit: 'b'.repeat(40), path: 'proposals/partial-group.mdx' } } as never);
			const currentPlan = { ...plan, endsAt: '2026-09-13T16:00:00Z', policySnapshot: { ...policy, durationSeconds: 3600, planningPercent: 20 } };
			const currentRun = { ...run, parameters: { appliedPlan: currentPlan, scheduledProjectIds: ['project'],
				proposalIds: [partial.id], groupIds: ['portfolio'], agentProfilesByProjectId: { project: { agents } } } };
			const store = { first: async () => null, all: async (sql: string) => sql.includes('FROM governance_proposals')
				? [{ id: partial.id, team_id: 'team', project_id: 'project' }]
				: currentPlan.planningRounds.flatMap(round => round.assignmentIds.map(id => ({ id, kind: 'planning', status: 'completed' }))),
				updateCapacityWorkdayRun: vi.fn(async () => currentRun) };
			const next = await advanceLivingWorkday(store as never, currentRun as never, '2026-09-13T15:03:00Z');
			expect(next.plan.planningRounds).toHaveLength(current ? 2 : 3);
			if (!current) expect(next.plan.planningRounds.at(-1)!.assignmentIds.filter(id => id.includes(':estimating:'))).toHaveLength(2);
			expect(next.plan.endsAt).toBe(currentPlan.endsAt); expect(next.plan.policySnapshot).toEqual(currentPlan.policySnapshot);
		}
	});
	it('cancels an explicitly stopped conversation without waiting for or fabricating a Reporter result', async () => {
		const conversation = { ...run, executionKind: 'conversation' } as never;
		const store = { all: vi.fn(async () => []), updateCapacityWorkdayRun: vi.fn(async () => conversation) };
		const result = await advanceLivingWorkday(store as never, conversation, now, true);
		expect(result).toMatchObject({ status: 'cancelled', plan: { state: 'closing', closingAt: now } });
		expect(appliedWorkdaySchema.parse(result.plan)).toEqual(result.plan);
		expect(result.plan.endedAt).toBeUndefined();
		expect(result.plan.reportRef).toBeUndefined();
		expect(store.updateCapacityWorkdayRun).toHaveBeenCalledWith('team', 'workday', expect.objectContaining({ status: 'cancelled' }));
	});
	it('creates a third and subsequent planning cycle before the percentage boundary', async () => {
		const startsAt = '2026-09-13T15:00:00Z';
		const currentPlan = { ...plan, startsAt, endsAt: '2026-09-13T16:00:00Z',
			policySnapshot: { ...policy, durationSeconds: 3600, planningPercent: 20 } };
		const currentRun = { ...run, parameters: { appliedPlan: currentPlan, groupIds: ['portfolio'], scheduledProjectIds: ['project'],
			agentProfilesByProjectId: { project: { agents: [{ definition: planningAgent('architect'), activities: ['planning'] }] } } } } as never;
		const store = { all: vi.fn(async (sql: string) => sql.includes('FROM governance_proposals') ? [] : currentPlan.planningRounds.map((round) =>
			({ id: round.assignmentIds[0], kind: 'planning', status: 'completed' }))),
			updateCapacityWorkdayRun: vi.fn(async () => currentRun) };
		const result = await advanceLivingWorkday(store as never, currentRun, '2026-09-13T15:02:00Z');
		expect(result.plan.planningRounds.at(-1)).toMatchObject({ round: 3, state: 'active',
			assignmentIds: ['planning:workday:3:project/project/architect:planning'] });
	});
	it('adds every frozen group subscriber to a newly discovered proposal without class or Reviewer preference', async () => {
		const currentPlan = { ...plan, endsAt: '2026-09-13T16:00:00Z',
			policySnapshot: { ...policy, durationSeconds: 3600, planningPercent: 20 } };
		expect(validateAgentDefinitionModel(planningAgent('researcher')).ok).toBe(true);
		const currentRun = { ...run, parameters: { appliedPlan: currentPlan, groupIds: ['portfolio'], scheduledProjectIds: ['project'],
			agentProfilesByProjectId: { project: { agents: ['architect', 'researcher', 'reviewer'].map((agentClass) =>
				({ definition: planningAgent(agentClass), activities: ['planning', 'estimating'] })) } } } } as never;
		const store = { all: vi.fn(async (sql: string) => sql.includes('execution_nodes')
			? currentPlan.planningRounds.flatMap((round) => round.assignmentIds.map((id) => ({ id, kind: 'planning', status: 'completed' })))
			: [{ id: 'incomplete', team_id: 'team', project_id: 'project' },
				{ id: 'new-proposal', team_id: 'team', project_id: 'project' }]),
			updateCapacityWorkdayRun: vi.fn(async () => currentRun) };
		const result = await advanceLivingWorkday(store as never, currentRun, '2026-09-13T15:02:00Z');
		expect(result.plan.planningRounds.at(-1)?.assignmentIds).toEqual(['architect', 'researcher', 'reviewer']
			.flatMap(name => ['estimating', 'planning'].map(activity => `planning:workday:3:project/project/${name}:${activity}:new-proposal`)).sort());
		expect(store.updateCapacityWorkdayRun).toHaveBeenCalledWith('team', 'workday', expect.objectContaining({
			parameters: expect.objectContaining({ proposalIds: [], planningSourceByProposalId: { 'new-proposal': expect.objectContaining({ id: 'new-proposal' }) } }),
		}));
	});
	it('stops regenerating terminal explicit proposal and decision scope without shortening the planning phase', async () => {
		for (const scope of ['proposal', 'decision']) {
			const currentPlan = { ...plan, endsAt: '2026-09-13T16:00:00Z',
				policySnapshot: { ...policy, durationSeconds: 3600, planningPercent: 20 } };
			const parameters = { appliedPlan: currentPlan, scheduledProjectIds: ['project'],
				...(scope === 'proposal' ? { proposalIds: ['accepted'] } : { decisionIds: ['decision'] }) };
			const currentRun = { ...run, parameters } as never;
			const store = { all: vi.fn(async (sql: string) => {
				if (sql.includes('FROM governance_decisions')) return [{ id: 'decision', proposal_id: 'accepted' }];
				if (sql.includes('FROM governance_proposals')) return [];
				return currentPlan.planningRounds.flatMap(round => round.assignmentIds.map(id => ({ id, kind: 'planning', status: 'completed' })));
			}), updateCapacityWorkdayRun: vi.fn(async () => currentRun) };
			const result = await advanceLivingWorkday(store as never, currentRun, '2026-09-13T15:03:00Z');
			expect(result.plan.planningRounds).toHaveLength(2);
			expect(result.plan.planningRounds.every(round => round.state === 'complete')).toBe(true);
			expect(result.plan).toMatchObject({ state: 'active', startsAt: currentPlan.startsAt, endsAt: currentPlan.endsAt,
				policySnapshot: currentPlan.policySnapshot });
			expect(store.all).toHaveBeenCalledWith(expect.stringContaining("status IN ('draft','submitted','open','voting')"),
				['team', 'project', 'accepted']);
			const settledRun = { ...run, parameters: { ...parameters, appliedPlan: result.plan } };
			const again = await advanceLivingWorkday(store as never, settledRun as never, '2026-09-13T15:04:00Z');
			expect(again.changed).toBe(false);
			expect(again.plan.planningRounds).toHaveLength(2);
		}
	});
	it('does not regenerate historical planning IDs for an unreadable scoped proposal', async () => {
		const currentPlan = { ...plan, endsAt: '2026-09-13T16:00:00Z',
			policySnapshot: { ...policy, durationSeconds: 3600, planningPercent: 20 } };
		const currentRun = { ...run, parameters: { appliedPlan: currentPlan, scheduledProjectIds: ['project'],
			proposalIds: ['accepted', 'incomplete'] } } as never;
		const store = { all: vi.fn(async (sql: string) => sql.includes('FROM governance_proposals')
			? [{ id: 'incomplete', team_id: 'team', project_id: 'project' }]
			: currentPlan.planningRounds.flatMap(round => round.assignmentIds.map(id => ({ id, kind: 'planning', status: 'completed' })))),
			updateCapacityWorkdayRun: vi.fn(async () => currentRun) };
		const result = await advanceLivingWorkday(store as never, currentRun, '2026-09-13T15:03:00Z');
		expect(result.plan.planningRounds).toHaveLength(2);
		expect(result.plan.planningRounds.every(round => round.state === 'complete')).toBe(true);
	});
	it('keeps one or several explicit proposals while ignoring unrelated open proposals', async () => {
		for (const selected of [['new-proposal'], ['new-proposal', 'other-proposal']]) {
			const currentPlan = { ...plan, endsAt: '2026-09-13T16:00:00Z',
			policySnapshot: { ...policy, durationSeconds: 3600, planningPercent: 20 } };
			const currentRun = { ...run, parameters: { appliedPlan: currentPlan, groupIds: ['portfolio'], scheduledProjectIds: ['project'],
			proposalIds: selected, agentProfilesByProjectId: { project: { agents: ['architect', 'researcher', 'reviewer']
				.map((agentClass) => ({ definition: planningAgent(agentClass), activities: ['planning', 'estimating'] })) } } } } as never;
			const inventory = ['new-proposal', 'other-proposal', 'unrelated'].map((id) => ({ id, team_id: 'team', project_id: 'project' }));
			const store = { all: vi.fn(async (sql: string, args: unknown[]) => sql.includes('execution_nodes')
			? currentPlan.planningRounds.flatMap((round) => round.assignmentIds.map((id) => ({ id, kind: 'planning', status: 'completed' })))
			: inventory.filter((proposal) => !sql.includes('AND id IN') || args.includes(proposal.id))),
			updateCapacityWorkdayRun: vi.fn(async () => currentRun) };
			const result = await advanceLivingWorkday(store as never, currentRun, '2026-09-13T15:02:00Z');
			const next = result.plan.planningRounds.at(-1)!;
			expect(next.assignmentIds).toEqual(selected.flatMap(proposalId => ['architect', 'researcher', 'reviewer']
				.flatMap(name => ['planning', 'estimating'].map(activity => `planning:workday:3:project/project/${name}:${activity}:${proposalId}`))).sort());
			expect(next.assignmentIds.every((id) => !id.includes('unrelated'))).toBe(true);
			expect(store.all).toHaveBeenCalledWith(expect.stringContaining(`AND id IN (${selected.map(() => '?').join(',')})`),
			['team', 'project', ...selected]);
			expect(store.updateCapacityWorkdayRun).toHaveBeenCalledWith('team', 'workday', expect.objectContaining({
			parameters: expect.objectContaining({ proposalIds: selected,
				planningSourceByProposalId: Object.fromEntries(selected.map((id) => [id, expect.objectContaining({ id })])) }),
		}));
		}
	});
	it('keeps decision-only continuation planning scoped without rediscovering unrelated proposals', async () => {
		for (const proposalIds of [[], ['explicit']]) {
			const currentPlan = { ...plan, endsAt: '2026-09-13T16:00:00Z',
				policySnapshot: { ...policy, durationSeconds: 3600, planningPercent: 20 } };
			const currentRun = { ...run, parameters: { appliedPlan: currentPlan, groupIds: ['portfolio'], scheduledProjectIds: ['project'],
				decisionIds: ['decision', 'second'], proposalIds, continueFromWorkdayId: 'settled',
				agentProfilesByProjectId: { project: { agents: ['architect', 'researcher', 'reviewer'].map(agentClass =>
					({ definition: planningAgent(agentClass), activities: ['planning', 'estimating'] })) } } } } as never;
			const store = { all: vi.fn(async (sql: string, args: unknown[]) => {
				if (sql.includes('FROM governance_decisions')) return [{ id: 'decision', proposal_id: 'ready' },
					{ id: 'second', proposal_id: 'revised' }];
				if (sql.includes('execution_nodes')) return currentPlan.planningRounds.flatMap(round =>
					round.assignmentIds.map(id => ({ id, kind: 'planning', status: 'completed' })));
				return ['ready', 'revised', 'explicit', 'unrelated'].filter(id => args.includes(id))
					.map(id => ({ id, team_id: 'team', project_id: 'project' }));
			}), updateCapacityWorkdayRun: vi.fn(async () => currentRun) };
			const result = await advanceLivingWorkday(store as never, currentRun, '2026-09-13T15:02:00Z');
			expect(store.all).toHaveBeenCalledWith(expect.stringContaining('WHERE team_id=? AND id IN (?,?)'),
				['team', 'decision', 'second']);
			expect(store.all).toHaveBeenCalledWith(expect.stringContaining('AND id IN'),
				['team', 'project', ...proposalIds, 'ready', 'revised']);
			expect(result.plan.planningRounds.at(-1)?.assignmentIds.some(id => id.includes('unrelated'))).toBe(false);
			expect(result.plan.planningRounds.at(-1)?.assignmentIds.filter(id => id.includes(':estimating:')))
				.toHaveLength(proposalIds.length * 3);
			expect(store.updateCapacityWorkdayRun).toHaveBeenCalledWith('team', 'workday', expect.objectContaining({
				parameters: expect.objectContaining({ proposalIds, decisionIds: ['decision', 'second'] }) }));
		}
	});
	it('fails closed on missing or foreign-team decision planning scope before proposal discovery', async () => {
		for (const decisions of [[], [{ id: 'decision', proposal_id: null }]]) {
			const currentPlan = { ...plan, endsAt: '2026-09-13T16:00:00Z',
				policySnapshot: { ...policy, durationSeconds: 3600, planningPercent: 20 } };
			const currentRun = { ...run, parameters: { appliedPlan: currentPlan, decisionIds: ['decision'] } } as never;
			const store = { all: vi.fn(async (sql: string) => sql.includes('FROM governance_decisions') ? decisions
				: currentPlan.planningRounds.flatMap(round => round.assignmentIds.map(id => ({ id, kind: 'planning', status: 'completed' })))),
				updateCapacityWorkdayRun: vi.fn() };
			await expect(advanceLivingWorkday(store as never, currentRun, '2026-09-13T15:02:00Z'))
				.rejects.toMatchObject({ code: 'workday_planning_decision_scope_invalid' });
			expect(store.all.mock.calls.some(([sql]) => sql.includes('FROM governance_proposals'))).toBe(false);
			expect(store.updateCapacityWorkdayRun).not.toHaveBeenCalled();
		}
	});
	it.each(['ready', 'revised'])('does not repeat an estimating-only round after %s estimates are complete', async proposalId => {
		const initialId = `planning:workday:1:project/project/researcher:estimating:${proposalId}`;
		const currentPlan = { ...plan, endsAt: '2026-09-13T16:00:00Z', planningRounds: [
			{ round: 1, state: 'complete', assignmentIds: [initialId],
				startedAt: '2026-09-13T15:00:00Z', completedAt: '2026-09-13T15:01:00Z' },
		], policySnapshot: { ...policy, durationSeconds: 3600, planningPercent: 20 } };
		const currentRun = { ...run, parameters: { appliedPlan: currentPlan, scheduledProjectIds: ['project'],
			groupIds: ['portfolio'], proposalIds: [proposalId], agentProfilesByProjectId: { project: { agents: ['researcher', 'reviewer'].map(agentClass =>
				({ definition: planningAgent(agentClass), activities: ['estimating'] })) } } } } as never;
		const store = { all: vi.fn(async (sql: string) => sql.includes('execution_nodes')
			? [{ id: initialId, kind: 'estimating', status: 'completed' }]
			: [{ id: proposalId, team_id: 'team', project_id: 'project' }]),
			getGovernanceProposal: vi.fn(async () => ({ id: proposalId, team_id: 'team', project_id: 'project' })),
			updateCapacityWorkdayRun: vi.fn(async () => currentRun) };
		const result = await advanceLivingWorkday(store as never, currentRun, '2026-09-13T15:02:00Z');
		expect(result.plan.planningRounds).toEqual(currentPlan.planningRounds);
		expect(result.plan).toMatchObject({ state: 'active', startsAt: currentPlan.startsAt,
			endsAt: currentPlan.endsAt, policySnapshot: currentPlan.policySnapshot });
		const closingRun = { ...currentRun, parameters: { ...currentRun.parameters, appliedPlan: result.plan } } as never;
		const closing = await advanceLivingWorkday(store as never, closingRun, '2026-09-13T15:03:00Z', true);
		expect(closing.plan.planningRounds.every(round => round.state === 'complete')).toBe(true);
		expect(closing.plan.state).toBe('closing');
		expect(closing.plan.endsAt).toBe(currentPlan.endsAt);
	});
	it('continues collaborative planning without regenerating estimates after the proposal is ready', async () => {
		const currentPlan = { ...plan, endsAt: '2026-09-13T16:00:00Z', planningRounds: [
			{ round: 1, state: 'complete', assignmentIds: [
				'planning:workday:1:project/project/architect:planning',
				'planning:workday:1:project/project/architect:estimating',
			], startedAt: '2026-09-13T15:00:00Z', completedAt: '2026-09-13T15:01:00Z' },
		],
			policySnapshot: { ...policy, durationSeconds: 3600, planningPercent: 20 } };
		const permissions = { content: { read: ['proposal'], write: ['proposal'] }, tools: ['discussion'] };
		const agent = (agentClass: string) => ({ schemaVersion: 'treeseed.agent/v1', id: `project/${agentClass}`,
			name: agentClass, agentClass: 'maintenance', groupIds: ['portfolio'], purpose: 'Plan governed work.', responsibilities: ['Return exact results.'],
			capabilities: ['reasoning'], context: { include: ['project-objectives'] }, activityProfiles: {
				planning: { handler: 'writer', permissions, prompt: { system: 'Plan useful governed work.' } },
				estimating: { handler: 'estimate', permissions, prompt: { system: 'Estimate exact work.' } },
			} });
		const currentRun = { ...run, parameters: { appliedPlan: currentPlan, scheduledProjectIds: ['project'],
			groupIds: ['portfolio'],
			planningSourceByProposalId: { ready: { store: 'treedx', model: 'proposal', id: 'ready', revision: 1,
				digest: `sha256:${'a'.repeat(64)}`, repository: 'project-library', commit: 'b'.repeat(40), path: 'proposals/ready.mdx' } },
			agentProfilesByProjectId: { project: { agents: ['architect', 'researcher', 'reviewer'].map((agentClass) =>
				({ definition: agent(agentClass), activities: ['planning', 'estimating'] })) } } } } as never;
		const store = { all: vi.fn(async (sql: string) => sql.includes('execution_nodes')
			? currentPlan.planningRounds.flatMap((round) => round.assignmentIds.map((id) => ({ id, kind: 'planning', status: 'completed' })))
			: [{ id: 'ready', team_id: 'team', project_id: 'project' }]), getGovernanceProposal: vi.fn(async () => ({ id: 'ready', team_id: 'team', project_id: 'project' })),
			updateCapacityWorkdayRun: vi.fn(async () => currentRun) };
		const result = await advanceLivingWorkday(store as never, currentRun, '2026-09-13T15:02:00Z');
		expect(result.plan.planningRounds.at(-1)?.assignmentIds).toEqual(['architect', 'researcher', 'reviewer']
			.map(name => `planning:workday:2:project/project/${name}:planning`));
	});
	it.each(['ready', 'revised'])('keeps planning a populated %s proposal until genuine group participation is current', async proposalId => {
		contributionProof.mockResolvedValue({ current: false, attempts: [], missing: ['project/project/architect'] });
		const currentPlan = { ...plan, endsAt: '2026-09-13T16:00:00Z', planningRounds: [
			{ round: 1, state: 'complete', assignmentIds: ['planning:workday:1:project/project/architect:planning'],
				startedAt: '2026-09-13T15:00:00Z', completedAt: '2026-09-13T15:01:00Z' },
			{ round: 2, state: 'complete', assignmentIds: ['planning:workday:2:project/project/architect:planning'],
				startedAt: '2026-09-13T15:01:00Z', completedAt: '2026-09-13T15:02:00Z' },
		], policySnapshot: { ...policy, durationSeconds: 3600, planningPercent: 20 } };
		const currentRun = { ...run, parameters: { appliedPlan: currentPlan, scheduledProjectIds: ['project'],
			proposalIds: [proposalId], groupIds: ['portfolio'],
			agentProfilesByProjectId: { project: { agents: [{ definition: planningAgent('architect'), activities: ['planning', 'estimating'] }] } },
			planningSourceByProposalId: { [proposalId]: { store: 'treedx', model: 'proposal', id: proposalId, revision: 1,
				digest: `sha256:${'a'.repeat(64)}`, repository: 'project-library', commit: 'b'.repeat(40), path: 'proposals/ready.mdx' } } } } as never;
		const store = { all: vi.fn(async (sql: string) => sql.includes('execution_nodes')
			? currentPlan.planningRounds.flatMap((round) => round.assignmentIds.map((id) => ({ id, kind: 'planning', status: 'completed' })))
			: [{ id: proposalId, team_id: 'team', project_id: 'project' }]), getGovernanceProposal: vi.fn(async () => ({ id: proposalId, team_id: 'team', project_id: 'project' })),
			updateCapacityWorkdayRun: vi.fn(async () => currentRun) };
		const result = await advanceLivingWorkday(store as never, currentRun, '2026-09-13T15:03:00Z');
		expect(result.plan.planningRounds).toHaveLength(3);
		expect(result.plan.planningRounds.at(-1)!.assignmentIds).toEqual(['estimating', 'planning']
			.map(activity => `planning:workday:3:project/project/architect:${activity}:${proposalId}`));
	});
	it('completes planning rounds and enters closing without consulting demand or envelope storage', async () => {
		const updateCapacityWorkdayRun = vi.fn(async () => run);
		const store = { all: vi.fn(async (sql: string) => sql.includes('SELECT id,kind,status') ? [
			{ id: 'planning:workday:1:project/architect:planning', kind: 'planning', status: 'completed' },
			{ id: 'planning:workday:2:project/architect:planning', kind: 'planning', status: 'completed' },
			{ id: 'reporting:workday:project/reporter', kind: 'reporting', status: 'ready' },
		] : sql.includes('JOIN execution_edges') ? [{ status: 'completed' }] : []), updateCapacityWorkdayRun };
		const result = await advanceLivingWorkday(store as never, run, now);
		expect(result.plan).toMatchObject({ state: 'closing', planningRounds: [{ state: 'complete' }, { state: 'complete' }] });
		const sql = store.all.mock.calls.map(([query]) => query).join('\n');
		expect(sql).not.toMatch(/capacity_workday_demands|workday_capacity_envelopes/u);
	});

	it.each(['failed', 'cancelled', 'stale'])('retains %s Reporter failure evidence without ending a workday that has no closeout report', async status => {
		const closingRun = { ...run, parameters: { appliedPlan: { ...plan, state: 'closing', closingAt: now } } } as never;
		const store = { all: vi.fn(async (sql: string) => sql.includes('execution_nodes')
			? [{ id: 'report', kind: 'reporting', status }] : [{ state: 'released' }]),
			updateCapacityWorkdayRun: vi.fn(async () => closingRun) };
		expect(await advanceLivingWorkday(store as never, closingRun, now)).toMatchObject({
			status: 'failed', plan: { state: 'closing' } });
	});
	it('does not end a failed Reporter until reservations are settled', async () => {
		const closingRun = { ...run, parameters: { appliedPlan: { ...plan, state: 'closing', closingAt: now } } } as never;
		const store = { all: vi.fn(async (sql: string) => sql.includes('execution_nodes')
			? [{ id: 'report', kind: 'reporting', status: 'failed' }] : [{ state: 'consuming' }]),
			updateCapacityWorkdayRun: vi.fn(async () => closingRun) };
		expect(await advanceLivingWorkday(store as never, closingRun, now)).toMatchObject({
			status: 'running', plan: { state: 'closing' } });
	});
	it('keeps Reporter responsible for closeout even when selected decision work failed', async () => {
		const closingRun = { ...run, parameters: { appliedPlan: { ...plan, state: 'closing', closingAt: now } } } as never;
		const store = { all: vi.fn(async (sql: string) => sql.includes('SELECT id,kind,status')
			? [{ id: 'report', kind: 'reporting', status: 'blocked' }]
			: sql.includes('JOIN execution_edges') ? [{ status: 'failed' }] : [{ state: 'released' }]),
			updateCapacityWorkdayRun: vi.fn(async () => closingRun) };
		expect(await advanceLivingWorkday(store as never, closingRun, now)).toMatchObject({
			status: 'running', plan: { state: 'closing' } });
	});
	it.each(['ready', 'blocked', 'assigned', 'running'])('does not fail closeout merely because selected decision work remains %s', async status => {
		const closingRun = { ...run, parameters: { appliedPlan: { ...plan, state: 'closing', closingAt: now } } } as never;
		const store = { all: vi.fn(async (sql: string) => sql.includes('SELECT id,kind,status')
			? [{ id: 'report', kind: 'reporting', status: 'blocked' }]
			: sql.includes('JOIN execution_edges') ? [{ status }] : [{ state: 'released' }]),
			updateCapacityWorkdayRun: vi.fn(async () => closingRun) };
		expect(await advanceLivingWorkday(store as never, closingRun, now)).toMatchObject({
			status: 'running', plan: { state: 'closing' } });
	});
	it('ends only after Reporter completion and reservation settlement', async () => {
		const closing = { ...plan, state: 'closing', closingAt: now } as const;
		const closingRun = { ...run, parameters: { appliedPlan: closing } } as never;
		const updateCapacityWorkdayRun = vi.fn(async (_team: string, _id: string, _input: Record<string, unknown>) => closingRun);
		const store = { all: vi.fn(async (sql: string) => sql.includes('SELECT id,kind,status')
			? [{ id: 'reporting:workday:project/reporter', kind: 'reporting', status: 'completed' }]
			: sql.includes('assignment_result_json') ? [{ id: 'assignment', assignment_result_json: JSON.stringify(reportResult),
				integrated_at: now, integration_json: JSON.stringify({ resultId: reportResult.id, references: reportResult.references, publication: false }) }]
			: sql.includes('SELECT DISTINCT provider_session_id') ? []
			: sql.includes('JOIN execution_edges') ? [{ status: 'completed' }] : [{ state: 'consumed' }]), updateCapacityWorkdayRun };
		const result = await advanceLivingWorkday(store as never, closingRun, now);
		expect(result).toMatchObject({ changed: true, status: 'completed', plan: { state: 'ended', endedAt: now, reportRef: reportReference } });
		expect(updateCapacityWorkdayRun).toHaveBeenCalledWith('team', 'workday', expect.objectContaining({
			parameters: expect.objectContaining({ appliedPlan: expect.objectContaining({ reportRef: reportReference }) }) }));
		expect(updateCapacityWorkdayRun.mock.calls[0]?.[2]).not.toHaveProperty('reportRefs');
	});
	it.each(['complete', 'missing-second', 'failed-second', 'unsettled'])('requires every group closeout receipt before ending a multi-project workday: %s', async mode => {
		const closingRun = { ...run, parameters: { appliedPlan: { ...plan, state: 'closing', closingAt: now } } } as never;
		const reports = [{ id: 'project-report', kind: 'reporting', status: 'completed' },
			{ id: 'other-report', kind: 'reporting', status: mode === 'failed-second' ? 'failed' : 'completed' }];
		const store = { all: vi.fn(async (sql: string, parameters: unknown[]) => {
			if (sql.includes('SELECT id,kind,status')) return reports;
			if (sql.includes('assignment_result_json')) {
				const second = parameters[2] === 'other-report';
				if (second && mode === 'missing-second') return [];
				const value = { ...reportResult, id: second ? 'other-result' : reportResult.id,
					assignmentId: second ? 'other-assignment' : reportResult.assignmentId,
					references: [{ ...reportReference, ...(second ? { projectId: 'other', path: 'notes/other-report.md' } : {}) }] };
				return [{ id: value.assignmentId, assignment_result_json: JSON.stringify(value), integrated_at: now,
					integration_json: JSON.stringify({ resultId: value.id, references: value.references, publication: false }) }];
			}
			if (sql.includes('SELECT DISTINCT provider_session_id')) return [];
			return [{ state: mode === 'unsettled' ? 'reserved' : 'consumed' }];
		}), updateCapacityWorkdayRun: vi.fn(async () => closingRun) };
		const result = await advanceLivingWorkday(store as never, closingRun, now);
		expect(result.status).toBe(mode === 'complete' ? 'completed' : mode === 'unsettled' ? 'running' : 'failed');
		if (mode === 'complete') expect(result.plan).toMatchObject({ state: 'ended', reportRef: { ...reportReference, projectId: 'other', path: 'notes/other-report.md' } });
		else expect(result.plan).not.toHaveProperty('reportRef');
	});
	it.each(['missing', 'duplicate', 'invalid', 'wrong-assignment', 'wrong-store', 'future-completion', 'missing-integration',
		'future-integration', 'wrong-result-integration', 'wrong-reference-integration', 'invalid-integration-time', 'invalid-integration-json'])('rejects %s Reporter evidence despite a completed graph node', async failure => {
		const closingRun = { ...run, parameters: { appliedPlan: { ...plan, state: 'closing', closingAt: now } } } as never;
		const result = { ...reportResult,
			...(failure === 'wrong-assignment' ? { assignmentId: 'another' } : {}),
			...(failure === 'wrong-store' ? { references: [] } : {}) };
		if (failure === 'future-completion') result.completedAt = '2026-09-13T16:01:00.000Z';
		const row = { id: 'assignment', assignment_result_json: failure === 'invalid' ? '{broken' : JSON.stringify(result),
			integrated_at: failure === 'missing-integration' ? null : failure === 'invalid-integration-time' ? 'malformed' : failure === 'future-integration' ? '2026-09-13T16:01:00.000Z' : now,
			integration_json: failure === 'invalid-integration-json' ? '{' : JSON.stringify({ resultId: failure === 'wrong-result-integration' ? 'foreign-result' : result.id,
				references: failure === 'wrong-reference-integration' ? [{ ...reportReference, commit: 'b'.repeat(40) }] : result.references, publication: false }) };
		const store = { all: vi.fn(async (sql: string) => sql.includes('SELECT id,kind,status')
			? [{ id: 'report', kind: 'reporting', status: 'completed' }]
			: sql.includes('assignment_result_json') ? failure === 'missing' ? [] : failure === 'duplicate' ? [row, row] : [row]
			: sql.includes('JOIN execution_edges') ? [{ status: 'completed' }] : [{ state: 'consumed' }]),
			updateCapacityWorkdayRun: vi.fn(async () => closingRun) };
		expect(await advanceLivingWorkday(store as never, closingRun, now)).toMatchObject({ status: 'failed' });
	});
});
