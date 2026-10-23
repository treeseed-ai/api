import { afterEach, describe, expect, it, vi } from 'vitest';
import { assignmentAttemptSchema, assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { assignment as original } from '../../../capacity/execution/fixtures/assignment.ts';
import { readyProposal } from '../architecture/ready-proposal-fixture.ts';
import { governanceProposalReadinessMethod } from '../../../../../../src/api/store/governance/policy/contracts/governance-proposal-readiness.ts';
import { ProjectAgentClassRepository } from '../../../../../../src/api/capacity/repositories/projects/agents/project-agent-class.ts';

const read = vi.hoisted(() => vi.fn());
const verifiedContribution = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../../../../../src/api/governance/executable-proposal.ts', async load => ({
	...await load<typeof import('../../../../../../src/api/governance/executable-proposal.ts')>(), readExactProposal: read,
}));
vi.mock('../../../../../../src/api/capacity/services/capacity/assignments/planning/estimates/integration.ts', async load => ({
	...await load<typeof import('../../../../../../src/api/capacity/services/capacity/assignments/planning/estimates/integration.ts')>(),
	isCurrentSubscriberContribution: verifiedContribution,
}));
afterEach(() => { vi.restoreAllMocks(); verifiedContribution.mockReset(); verifiedContribution.mockResolvedValue(true); });

function fixture(activity: 'planning' | 'estimating') {
	const names = ['technical-writer', 'tester'], base = readyProposal(), { agentClass: _class, ...item } = base.executionPlan.workItems[0]!;
	const definition = { ...base, schemaVersion: 'treeseed.proposal/v2', groupIds: ['provider-runtime'],
		executionPlan: { workItems: names.map(name => ({ ...item, id: `${name}-work`, estimateRef: {
			store: 'postgresql', model: 'assignment-attempt', id: `turn-${name}`, revision: 1 },
			estimate: { ...item.estimate, rationale: 'Own provider runtime contribution.' },
			reviewEstimate: { ...item.reviewEstimate, rationale: 'Own independent peer review.' } })) } };
	read.mockResolvedValue({ definition, ref: original.sourceRef, source: 'Controlled UNIT source; native proof is separate.' });
	const profiles = { handler: 'writer', permissions: { content: { read: ['proposal'], write: ['proposal'] }, tools: [] },
		prompt: { system: 'Contribute and estimate own real provider runtime repair.' } };
	const agents = names.map(name => ({ schemaVersion: 'treeseed.agent/v1', id: `project/${name}`, name,
		agentClass: 'maintenance', groupIds: ['provider-runtime'], purpose: 'Repair actual runtime source.',
		responsibilities: ['Own a useful contribution.'], capabilities: ['source-repair'], context: { include: ['assignment-subject'] },
		activityProfiles: { planning: profiles, estimating: profiles, acting: profiles, reviewing: profiles } }));
	const rows = names.map(name => {
		const id = `turn-${name}`, ref = { ...original.sourceRef, repository: 'library', commit: 'a'.repeat(40), path: 'proposals/proposal.mdx' };
		const attempt = assignmentAttemptSchema.parse({ ...original, id, projectId: 'project', agentClass: 'maintenance',
			workItemId: undefined, sourceRef: ref, effectiveProfile: { ...original.effectiveProfile, activity, handler: 'writer',
				profileRef: { store: 'treedx', model: 'agent', id: `project/${name}`, repository: 'library',
					commit: 'b'.repeat(40), path: `agents/${name}.mdx` } },
			workspace: { mode: 'treedx', workspaceId: `workspace-${name}`, repository: 'library', baseCommit: 'a'.repeat(40), writablePaths: ['proposals/proposal.mdx'] },
			grant: { contentRead: [ref], contentWrite: [ref], sourceRead: [], sourceWrite: [], tools: [] }, status: 'completed' });
		const result = assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: `result-${name}`,
			assignmentId: id, status: 'completed', summary: 'Controlled UNIT completion, not measured agent work.',
			references: [{ kind: 'treedx', projectId: 'project', repository: 'library', commit: 'c'.repeat(40), path: 'proposals/proposal.mdx', workspaceId: `workspace-${name}` }],
			verification: [], diagnostics: [], usage: { elapsedSeconds: 0 }, completedAt: original.createdAt });
		return { id, agent_id: `project/${name}`, team_id: 'team', project_id: 'project', assignment_attempt_json: attempt,
			assignment_result_json: result, integration_json: { resultId: result.id, references: result.references } };
	});
	const store = { getGovernanceProposal: async () => ({ id: 'proposal', teamId: 'team', projectId: 'project', activeVersion: 1, createdById: 'human' }),
		listTeamProjects: async () => [{ id: 'project' }], all: async (sql: string) => sql.includes('capacity_provider_assignments') ? rows : [] };
	vi.spyOn(ProjectAgentClassRepository.prototype, 'listPage').mockResolvedValue({ items: [{ id: 'allocation', slug: 'maintenance', status: 'active',
		handlerRefs: { agents } }], page: { hasMore: false, nextCursor: null } } as never);
	return { store, rows, definition, agents };
}

describe('every subscriber must own an estimate before approval', () => {
	it('refuses approval when a configured contributor prerequisite has no contribution in the group plan', async () => {
		const f = fixture('estimating'), agent = f.agents[0]!;
		Object.assign(agent.activityProfiles, { acting: { ...agent.activityProfiles.acting,
			dependsOn: { agents: ['unsubscribed-expert'] } } });
		const readiness = await governanceProposalReadinessMethod.call(f.store as never, 'proposal');
		expect(readiness).toMatchObject({ votingReady: false, executionPlanReady: false });
		expect(readiness!.missingVoting).toContain('group participation (execution_profile_dependency_missing)');
	});
	it('keeps execution readiness false when actual contributor profile dependencies create a cycle despite complete estimates', async () => {
		const f = fixture('estimating');
		for (const [index, agent] of f.agents.entries()) Object.assign(agent.activityProfiles, {
			acting: { ...agent.activityProfiles.acting, dependsOn: { agents: [f.agents[1 - index]!.id.split('/').at(-1)!] } },
		});
		const readiness = await governanceProposalReadinessMethod.call(f.store as never, 'proposal');
		expect(readiness).toMatchObject({
			votingReady: false, executionPlanReady: false,
		});
		expect(readiness!.missingVoting).toContain('group participation (execution_graph_invalid)');
	});
	it('refuses an additional contribution with no verified subscribed author even when every member has estimated', async () => {
		const f = fixture('estimating'), first = f.definition.executionPlan.workItems[0]!;
		f.definition.executionPlan.workItems.push({ ...first, id: 'foreign-work', estimateRef: { ...first.estimateRef, id: 'unproved-author' } });
		expect(await governanceProposalReadinessMethod.call(f.store as never, 'proposal')).toMatchObject({
			votingReady: false, missingParticipantEstimates: ['unverified contribution foreign-work'],
		});
	});
	it('does not accept discussion completions as each subscriber own estimate', async () => {
		const f = fixture('planning');
		expect(await governanceProposalReadinessMethod.call(f.store as never, 'proposal')).toMatchObject({
			votingReady: false, participationVersionReady: false,
			missingParticipantEstimates: ['project/project/technical-writer', 'project/project/tester'],
		});
		expect(verifiedContribution).not.toHaveBeenCalled();
	});
	it('requires genuine current contribution read-back for each same-class subscriber', async () => {
		const f = fixture('estimating'); verifiedContribution.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		expect(await governanceProposalReadinessMethod.call(f.store as never, 'proposal')).toMatchObject({
			votingReady: false, missingParticipantEstimates: ['project/project/tester'],
		});
		expect(verifiedContribution).toHaveBeenCalledTimes(2);
	});
	it('becomes ready only when both subscribers own verified estimates and denies mismatched row authors', async () => {
		const f = fixture('estimating');
		expect(await governanceProposalReadinessMethod.call(f.store as never, 'proposal')).toMatchObject({ votingReady: true, participationVersionReady: true });
		f.rows[1]!.agent_id = 'project/foreign-author';
		expect(await governanceProposalReadinessMethod.call(f.store as never, 'proposal')).toMatchObject({ votingReady: false,
			missingParticipantEstimates: ['project/project/tester'] });
	});
});
