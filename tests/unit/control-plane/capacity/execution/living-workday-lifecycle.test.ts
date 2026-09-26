import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-content-readback.ts', () => ({
	reconcileAssignmentContent: vi.fn(async () => undefined),
}));
import { advanceLivingWorkday } from '../../../../../src/api/capacity/services/capacity/workdays/lifecycle/living-workday-lifecycle.ts';
import { validateAgentDefinitionModel } from '@treeseed/sdk/agent-capacity';

vi.mock('../../../../../src/api/governance/executable-proposal.ts', async (importOriginal) => ({
	...await importOriginal<typeof import('../../../../../src/api/governance/executable-proposal.ts')>(),
	readExactProposal: vi.fn(async (_store: unknown, proposal: { id?: string }) => {
		if (proposal.id === 'incomplete') throw Object.assign(new Error('Proposal has no executable plan.'),
			{ code: 'proposal_execution_plan_invalid' });
		return { ref: { store: 'treedx', model: 'proposal', id: 'new-proposal', revision: 1,
		digest: `sha256:${'a'.repeat(64)}`, repository: 'project-library', commit: 'b'.repeat(40), path: 'proposals/new.mdx' },
		definition: { status: proposal.id === 'ready' ? 'ready' : proposal.id === 'revised' ? 'discussing' : 'draft',
			executionPlan: { workItems: [{ id: 'research', agentClass: 'researcher', review: 'required',
				...(proposal.id === 'ready' || proposal.id === 'revised' ? {
					estimate: { minimumSeconds: 60 }, reviewEstimate: { minimumSeconds: 30 },
				} : {}) }] } } };
	}),
}));

const now = '2026-09-13T16:00:00.000Z';
const policy = { durationSeconds: 60, maximumConcurrency: 2, planningTurnMaximumSeconds: 10,
	communicationConcurrency: 1, projectPercentages: { project: 100 }, agentClassPercentages: { project: { architect: 100 } } };
const plan = { schemaVersion: 'treeseed.workday/v1', id: 'workday', teamId: 'team', policyId: 'default', policyRevision: 1,
	executionMode: 'simulation',
	policySnapshot: policy, state: 'active', startsAt: '2026-09-13T15:00:00.000Z', endsAt: '2026-09-13T15:01:00.000Z',
	planningRounds: [{ round: 1, state: 'active', assignmentIds: ['planning:workday:1:project/architect'] },
		{ round: 2, state: 'pending', assignmentIds: ['planning:workday:2:project/architect'] }],
	admittedSecondsByProject: {}, admittedSecondsByAgentClass: {}, activatedAt: '2026-09-13T15:00:00.000Z' } as const;
const run = { id: 'workday', teamId: 'team', status: 'running', completedAt: null,
	reportRefs: {}, parameters: { appliedPlan: plan } } as never;
const reportReference = { kind: 'treedx', projectId: 'project', repository: 'team-library',
	commit: 'a'.repeat(40), path: 'notes/report.mdx', workspaceId: 'workspace' };
const reportResult = { schemaVersion: 'treeseed.assignment-result/v1', id: 'result', assignmentId: 'assignment',
	status: 'completed', summary: 'Recorded report.', references: [reportReference], verification: [],
	usage: { elapsedSeconds: 1 }, diagnostics: [], completedAt: now };

describe('living workday lifecycle', () => {
	it('cancels an explicitly stopped conversation without waiting for or fabricating a Reporter result', async () => {
		const conversation = { ...run, executionKind: 'conversation' } as never;
		const store = { all: vi.fn(async () => []), updateCapacityWorkdayRun: vi.fn(async () => conversation) };
		const result = await advanceLivingWorkday(store as never, conversation, now, true);
		expect(result).toMatchObject({ status: 'cancelled', plan: { state: 'ended', endedAt: now } });
		expect(store.updateCapacityWorkdayRun).toHaveBeenCalledWith('team', 'workday', expect.objectContaining({ status: 'cancelled' }));
	});
	it('creates a third and subsequent planning cycle before the percentage boundary', async () => {
		const startsAt = '2026-09-13T15:00:00Z';
		const currentPlan = { ...plan, startsAt, endsAt: '2026-09-13T16:00:00Z',
			policySnapshot: { ...policy, durationSeconds: 3600, planningPercent: 20 } };
		const currentRun = { ...run, parameters: { appliedPlan: currentPlan } } as never;
		const store = { all: vi.fn(async () => currentPlan.planningRounds.map((round) =>
			({ id: round.assignmentIds[0], kind: 'planning', status: 'completed' }))),
			updateCapacityWorkdayRun: vi.fn(async () => currentRun) };
		const result = await advanceLivingWorkday(store as never, currentRun, '2026-09-13T15:02:00Z');
		expect(result.plan.planningRounds.at(-1)).toMatchObject({ round: 3, state: 'active',
			assignmentIds: ['planning:workday:3:project/architect'] });
	});
	it('adds a newly created proposal owner and Reviewer to the next round without replacing the frozen planning agents', async () => {
		const currentPlan = { ...plan, endsAt: '2026-09-13T16:00:00Z',
			policySnapshot: { ...policy, durationSeconds: 3600, planningPercent: 20 } };
		const permissions = { content: { read: ['proposal'], write: ['proposal'] }, tools: ['discussion'] };
		const agent = (agentClass: string) => ({ schemaVersion: 'treeseed.agent/v1', id: `project/${agentClass}`,
			name: agentClass, agentClass, purpose: 'Estimate governed work.', responsibilities: ['Return exact results.'],
			capabilities: ['reasoning'], context: { include: ['project-objectives'] }, activityProfiles: {
				planning: { handler: 'writer', permissions, prompt: { system: 'Plan useful governed work for this project.' } },
				estimating: { handler: 'estimate', permissions, prompt: { system: 'Estimate exact proposal work for this project.' } },
			} });
		expect(validateAgentDefinitionModel(agent('researcher')).ok).toBe(true);
		const currentRun = { ...run, parameters: { appliedPlan: currentPlan, scheduledProjectIds: ['project'],
			agentProfilesByProjectId: { project: { agents: ['architect', 'researcher', 'reviewer'].map((agentClass) =>
				({ definition: agent(agentClass), activities: ['planning', 'estimating'] })) } } } } as never;
		const store = { all: vi.fn(async (sql: string) => sql.includes('execution_nodes')
			? currentPlan.planningRounds.flatMap((round) => round.assignmentIds.map((id) => ({ id, kind: 'planning', status: 'completed' })))
			: [{ id: 'incomplete', team_id: 'team', project_id: 'project' },
				{ id: 'new-proposal', team_id: 'team', project_id: 'project' }]),
			updateCapacityWorkdayRun: vi.fn(async () => currentRun) };
		const result = await advanceLivingWorkday(store as never, currentRun, '2026-09-13T15:02:00Z');
		expect(result.plan.planningRounds.at(-1)?.assignmentIds).toEqual([
			'planning:workday:3:project/architect',
			'planning:workday:3:project/project/researcher:estimating',
			'planning:workday:3:project/project/reviewer:estimating',
		]);
		expect(store.updateCapacityWorkdayRun).toHaveBeenCalledWith('team', 'workday', expect.objectContaining({
			parameters: expect.objectContaining({ planningSourceByProjectId: { project: expect.objectContaining({ id: 'new-proposal' }) } }),
		}));
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
			name: agentClass, agentClass, purpose: 'Plan governed work.', responsibilities: ['Return exact results.'],
			capabilities: ['reasoning'], context: { include: ['project-objectives'] }, activityProfiles: {
				planning: { handler: 'writer', permissions, prompt: { system: 'Plan useful governed work.' } },
				estimating: { handler: 'estimate', permissions, prompt: { system: 'Estimate exact work.' } },
			} });
		const currentRun = { ...run, parameters: { appliedPlan: currentPlan, scheduledProjectIds: ['project'],
			planningSourceByProjectId: { project: { store: 'treedx', model: 'proposal', id: 'ready', revision: 1,
				digest: `sha256:${'a'.repeat(64)}`, repository: 'project-library', commit: 'b'.repeat(40), path: 'proposals/ready.mdx' } },
			agentProfilesByProjectId: { project: { agents: ['architect', 'researcher', 'reviewer'].map((agentClass) =>
				({ definition: agent(agentClass), activities: ['planning', 'estimating'] })) } } } } as never;
		const store = { all: vi.fn(async (sql: string) => sql.includes('execution_nodes')
			? currentPlan.planningRounds.flatMap((round) => round.assignmentIds.map((id) => ({ id, kind: 'planning', status: 'completed' })))
			: []), getGovernanceProposal: vi.fn(async () => ({ id: 'ready', team_id: 'team', project_id: 'project' })),
			updateCapacityWorkdayRun: vi.fn(async () => currentRun) };
		const result = await advanceLivingWorkday(store as never, currentRun, '2026-09-13T15:02:00Z');
		expect(result.plan.planningRounds.at(-1)?.assignmentIds).toEqual([
			'planning:workday:2:project/project/architect:planning',
		]);
	});
	it.each(['ready', 'revised'])('advances a fully estimated %s proposal to governance review after two cycles', async proposalId => {
		const currentPlan = { ...plan, endsAt: '2026-09-13T16:00:00Z', planningRounds: [
			{ round: 1, state: 'complete', assignmentIds: ['planning:workday:1:project/project/architect:planning'],
				startedAt: '2026-09-13T15:00:00Z', completedAt: '2026-09-13T15:01:00Z' },
			{ round: 2, state: 'complete', assignmentIds: ['planning:workday:2:project/project/architect:planning'],
				startedAt: '2026-09-13T15:01:00Z', completedAt: '2026-09-13T15:02:00Z' },
		], policySnapshot: { ...policy, durationSeconds: 3600, planningPercent: 20 } };
		const currentRun = { ...run, parameters: { appliedPlan: currentPlan, scheduledProjectIds: ['project'],
			planningSourceByProjectId: { project: { store: 'treedx', model: 'proposal', id: proposalId, revision: 1,
				digest: `sha256:${'a'.repeat(64)}`, repository: 'project-library', commit: 'b'.repeat(40), path: 'proposals/ready.mdx' } } } } as never;
		const store = { all: vi.fn(async (sql: string) => sql.includes('execution_nodes')
			? currentPlan.planningRounds.flatMap((round) => round.assignmentIds.map((id) => ({ id, kind: 'planning', status: 'completed' })))
			: []), getGovernanceProposal: vi.fn(async () => ({ id: proposalId, team_id: 'team', project_id: 'project' })),
			updateCapacityWorkdayRun: vi.fn(async () => currentRun) };
		const result = await advanceLivingWorkday(store as never, currentRun, '2026-09-13T15:03:00Z');
		expect(result.plan.planningRounds).toHaveLength(2);
	});
	it('completes planning rounds and enters closing without consulting demand or envelope storage', async () => {
		const updateCapacityWorkdayRun = vi.fn(async () => run);
		const store = { all: vi.fn(async (sql: string) => sql.includes('SELECT id,kind,status') ? [
			{ id: 'planning:workday:1:project/architect', kind: 'planning', status: 'completed' },
			{ id: 'planning:workday:2:project/architect', kind: 'planning', status: 'completed' },
			{ id: 'reporting:workday:project/reporter', kind: 'reporting', status: 'ready' },
		] : sql.includes('JOIN execution_edges') ? [{ status: 'completed' }] : []), updateCapacityWorkdayRun };
		const result = await advanceLivingWorkday(store as never, run, now);
		expect(result.plan).toMatchObject({ state: 'closing', planningRounds: [{ state: 'complete' }, { state: 'complete' }] });
		const sql = store.all.mock.calls.map(([query]) => query).join('\n');
		expect(sql).not.toMatch(/capacity_workday_demands|workday_capacity_envelopes/u);
	});

	it.each(['failed', 'cancelled', 'stale'])('settles a %s Reporter as a failed workday, not success or an endless drain', async status => {
		const closingRun = { ...run, parameters: { appliedPlan: { ...plan, state: 'closing', closingAt: now } } } as never;
		const store = { all: vi.fn(async (sql: string) => sql.includes('execution_nodes')
			? [{ id: 'report', kind: 'reporting', status }] : [{ state: 'released' }]),
			updateCapacityWorkdayRun: vi.fn(async () => closingRun) };
		expect(await advanceLivingWorkday(store as never, closingRun, now)).toMatchObject({
			status: 'failed', plan: { state: 'ended', endedAt: now } });
	});
	it('does not end a failed Reporter until reservations are settled', async () => {
		const closingRun = { ...run, parameters: { appliedPlan: { ...plan, state: 'closing', closingAt: now } } } as never;
		const store = { all: vi.fn(async (sql: string) => sql.includes('execution_nodes')
			? [{ id: 'report', kind: 'reporting', status: 'failed' }] : [{ state: 'consuming' }]),
			updateCapacityWorkdayRun: vi.fn(async () => closingRun) };
		expect(await advanceLivingWorkday(store as never, closingRun, now)).toMatchObject({
			status: 'running', plan: { state: 'closing' } });
	});
	it('fails closeout without running Reporter when a selected decision terminal is failed', async () => {
		const closingRun = { ...run, parameters: { appliedPlan: { ...plan, state: 'closing', closingAt: now } } } as never;
		const store = { all: vi.fn(async (sql: string) => sql.includes('SELECT id,kind,status')
			? [{ id: 'report', kind: 'reporting', status: 'blocked' }]
			: sql.includes('JOIN execution_edges') ? [{ status: 'failed' }] : [{ state: 'released' }]),
			updateCapacityWorkdayRun: vi.fn(async () => closingRun) };
		expect(await advanceLivingWorkday(store as never, closingRun, now)).toMatchObject({
			status: 'failed', plan: { state: 'ended', endedAt: now } });
	});
	it.each(['ready', 'blocked', 'assigned', 'running'])('fails bounded closeout when a selected decision terminal remains %s', async status => {
		const closingRun = { ...run, parameters: { appliedPlan: { ...plan, state: 'closing', closingAt: now } } } as never;
		const store = { all: vi.fn(async (sql: string) => sql.includes('SELECT id,kind,status')
			? [{ id: 'report', kind: 'reporting', status: 'blocked' }]
			: sql.includes('JOIN execution_edges') ? [{ status }] : [{ state: 'released' }]),
			updateCapacityWorkdayRun: vi.fn(async () => closingRun) };
		expect(await advanceLivingWorkday(store as never, closingRun, now)).toMatchObject({
			status: 'failed', plan: { state: 'ended', endedAt: now } });
	});
	it('ends only after Reporter completion and reservation settlement', async () => {
		const closing = { ...plan, state: 'closing', closingAt: now } as const;
		const closingRun = { ...run, parameters: { appliedPlan: closing } } as never;
		const updateCapacityWorkdayRun = vi.fn(async () => closingRun);
		const store = { all: vi.fn(async (sql: string) => sql.includes('SELECT id,kind,status')
			? [{ id: 'reporting:workday:project/reporter', kind: 'reporting', status: 'completed' }]
			: sql.includes('assignment_result_json') ? [{ id: 'assignment', assignment_result_json: JSON.stringify(reportResult) }]
			: sql.includes('JOIN execution_edges') ? [{ status: 'completed' }] : [{ state: 'consumed' }]), updateCapacityWorkdayRun };
		const result = await advanceLivingWorkday(store as never, closingRun, now);
		expect(result).toMatchObject({ changed: true, status: 'completed', plan: { state: 'ended', endedAt: now } });
		expect(updateCapacityWorkdayRun).toHaveBeenCalledWith('team', 'workday', expect.objectContaining({
			reportRefs: { 'reporting:workday:project/reporter': reportReference } }));
	});
	it.each(['missing', 'duplicate', 'invalid', 'wrong-assignment', 'wrong-store'])('rejects %s Reporter evidence despite a completed graph node', async failure => {
		const closingRun = { ...run, parameters: { appliedPlan: { ...plan, state: 'closing', closingAt: now } } } as never;
		const result = { ...reportResult,
			...(failure === 'wrong-assignment' ? { assignmentId: 'another' } : {}),
			...(failure === 'wrong-store' ? { references: [] } : {}) };
		const row = { id: 'assignment', assignment_result_json: failure === 'invalid' ? '{broken' : JSON.stringify(result) };
		const store = { all: vi.fn(async (sql: string) => sql.includes('SELECT id,kind,status')
			? [{ id: 'report', kind: 'reporting', status: 'completed' }]
			: sql.includes('assignment_result_json') ? failure === 'missing' ? [] : failure === 'duplicate' ? [row, row] : [row]
			: sql.includes('JOIN execution_edges') ? [{ status: 'completed' }] : [{ state: 'consumed' }]),
			updateCapacityWorkdayRun: vi.fn(async () => closingRun) };
		expect(await advanceLivingWorkday(store as never, closingRun, now)).toMatchObject({ status: 'failed' });
	});
});
