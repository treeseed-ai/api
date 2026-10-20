import { describe, expect, it } from 'vitest';
import { compileWorkday, DEFAULT_WORKDAY_POLICY } from '@treeseed/sdk/agent-capacity';
import { projectActiveWorkdays } from '../../../../../../../src/api/capacity/policy/execution/workday-execution-projector.ts';
import { profile } from './workday-profile-fixture.ts';

describe('group planning closeout', () => {
	it('projects the original unissued turn identities when closing the first group-admission candidate', () => {
		const definition = { ...profile('architect', { reporting: false }), groupIds: ['portfolio-atlas'] };
		const plan = compileWorkday({ id: 'group-workday', teamId: 'team', policyId: 'default', policyRevision: 1,
			executionMode: 'simulation', startsAt: '2026-10-20T15:47:00Z',
			policy: { ...DEFAULT_WORKDAY_POLICY, durationSeconds: 3600 }, agentIds: [`project/${definition.id}:planning`] });
		const parameters = { appliedPlan: { ...plan, state: 'closing', closingAt: '2026-10-20T15:48:00Z' },
			groupIds: ['portfolio-atlas'], scheduledProjectIds: ['project'],
			agentProfilesByProjectId: { project: { agents: [{ definition, activities: ['planning'] }] } } };
		const source = { id: plan.id, teamId: 'team', parameters,
			proposalsByProjectId: { project: [{ id: 'complete-snapshots', groupIds: ['portfolio-atlas'] }] } };
		const before = structuredClone(source);
		const result = projectActiveWorkdays({ teamId: 'team', revision: 1, sources: [source], profiles: {} });
		expect(result.nodes.map(node => node.id)).toEqual(plan.planningRounds.flatMap(round => round.assignmentIds));
		expect(result.nodes.every(node => node.kind === 'planning')).toBe(true);
		expect(source).toEqual(before);
	});
});
