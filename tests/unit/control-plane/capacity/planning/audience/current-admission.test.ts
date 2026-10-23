import { expect, it } from 'vitest';
import { automaticEstimatingProfiles } from '../automatic-estimating-native.ts';
import { workdayParticipants } from '../../../../../../src/api/capacity/policy/execution/workday-participants.ts';
import { projectActiveWorkdays } from '../../../../../../src/api/capacity/policy/execution/workday-execution-projector.ts';
import { compileWorkday, DEFAULT_WORKDAY_POLICY } from '@treeseed/sdk/agent-capacity';

const groupIds = ['portfolio-runtime'];
const snapshot = { project: { agents: automaticEstimatingProfiles(groupIds).map(definition => ({
	definition, activities: ['planning', 'estimating'],
})) } };

it('requires group authority for new autonomous planning rather than treating an arbitrary snapshot as an audience', () => {
	expect(workdayParticipants({ agentProfilesByProjectId: snapshot })).toEqual([]);
});

it('admits only subscribed autonomous planners even when the frozen inventory contains another group', () => {
	expect(workdayParticipants({ groupIds, agentProfilesByProjectId: snapshot }).map(entry => entry.definition.id))
		.toEqual(['native-renamed/engineer', 'native-renamed/reporter', 'native-renamed/reviewer']);
});

it('never derives new estimator work from legacy class or privileged reviewer selectors', () => {
	const legacy = { schemaVersion: 'treeseed.proposal/v1', id: 'legacy', executionPlan: {
		workItems: [{ id: 'repair', agentClass: 'maintenance', review: 'required' }],
	} };
	const parameters = { groupIds, agentProfilesByProjectId: snapshot, proposalsByProjectId: { project: [legacy] } };
	const before = structuredClone(parameters);
	expect(workdayParticipants(parameters)).toEqual([]);
	expect(parameters).toEqual(before);
});

it.each(['engineer', 'maintenance'])('resolves governed dependency identity without treating allocation class as an agent: %s', dependency => {
	const definitions = automaticEstimatingProfiles(groupIds);
	definitions.find(definition => definition.id === 'native-renamed/reviewer')!.activityProfiles.estimating!.dependsOn = { agents: [dependency] };
	const proposal = { schemaVersion: 'treeseed.proposal/v2', id: 'proposal', groupIds, request: 'Repair the real shared workload handoff.' };
	const parameters = { groupIds, agentProfilesByProjectId: { project: { agents: definitions.map(definition => ({ definition, activities: ['estimating'] })) } },
		proposalsByProjectId: { project: [proposal] } };
	const plan = compileWorkday({ id: 'current', teamId: 'team', policyId: 'default', policyRevision: 1, executionMode: 'simulation',
		startsAt: '2026-10-23T12:00:00Z', policy: DEFAULT_WORKDAY_POLICY, agentIds: workdayParticipants(parameters).map(entry => entry.id) });
	const input = { teamId: 'team', revision: 1, profiles: {}, sources: [{ id: plan.id, teamId: 'team', proposalsByProjectId: parameters.proposalsByProjectId,
		parameters: { ...parameters, appliedPlan: plan, scheduledProjectIds: ['project'], planningSourceByProposalId: { proposal: {
			store: 'treedx', model: 'proposal', id: 'proposal', repository: 'library', commit: 'a'.repeat(40), path: 'proposals/proposal.mdx',
		} } } }] };
	const before = structuredClone(input);
	if (dependency === 'maintenance') expect(() => projectActiveWorkdays(input)).toThrow(/not selected/u);
	else expect(projectActiveWorkdays(input).edges.map(edge => [edge.fromNodeId, edge.toNodeId])).toEqual([
		['planning:current:1:project/native-renamed/engineer:estimating:proposal', 'planning:current:1:project/native-renamed/reviewer:estimating:proposal'],
	]);
	expect(input).toEqual(before);
});
