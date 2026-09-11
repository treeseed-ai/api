import { describe, expect, it, vi } from 'vitest';
import { selectWorkdayAgents } from '../../../../../src/api/capacity/policy/workdays/workday.ts';
import { compileWorkdayPlanningGraphSnapshot } from '../../../../../src/api/capacity/services/capacity/workdays/policy/workday-planning-graph-policy.ts';

vi.mock('../../../../../src/api/capacity/services/capacity/workdays/policy/workday-agent-policy.ts', () => ({
	capacityWorkdayAgentsFromClasses: (agents: any[], selection: unknown) => selectWorkdayAgents(agents, selection),
}));
const agents = [
	{ nodeId: 'architect:planning', slug: 'architect', activityType: 'planning', projectAgentClassId: 'class-a', projectAgentClassSlug: 'engineering', planningIntent: {}, signalPolicy: {} },
	{ nodeId: 'architect:reviewing', slug: 'architect', activityType: 'reviewing', projectAgentClassId: 'class-a', projectAgentClassSlug: 'engineering', planningIntent: {}, signalPolicy: {} },
	{ nodeId: 'reviewer:reviewing', slug: 'reviewer', activityType: 'reviewing', projectAgentClassId: 'class-b', projectAgentClassSlug: 'assurance', planningIntent: {}, signalPolicy: {} },
];

describe('exact planning selection before graph construction', () => {
	it('intersects selectors without expanding to another activity or agent', () => {
		const result = compileWorkdayPlanningGraphSnapshot(agents, { agentSlugs: ['architect'], activityTypes: ['reviewing'] });
		expect(result.agents.map(agent => agent.nodeId)).toEqual(['architect:reviewing']);
		expect(result.graph.nodes.map(node => node.id)).toEqual(['architect:reviewing']);
	});
	it('retains unselected behavior and supports explicit union', () => {
		expect(compileWorkdayPlanningGraphSnapshot(agents, undefined).agents).toHaveLength(3);
		expect(compileWorkdayPlanningGraphSnapshot(agents, { classIds: ['class-a'], agentSlugs: ['reviewer'], mode: 'union' }).agents).toHaveLength(3);
	});
	it('rejects known selectors with an empty intersection', () => {
		expect(() => compileWorkdayPlanningGraphSnapshot(agents, { agentSlugs: ['reviewer'], activityTypes: ['planning'] })).toThrowError(/no eligible/u);
	});
	for (const selection of [{ agentSlugs: ['architect', 'typo'] }, { activityTypes: ['reviewng'] }, { classSlugs: ['project:engineering'] }, { classIds: ['missing'], agentSlugs: ['architect'], mode: 'union' }]) {
		it(`rejects unknown selectors even when another selector matches: ${JSON.stringify(selection)}`, () => {
			expect(() => compileWorkdayPlanningGraphSnapshot(agents, selection)).toThrowError(/exactly/u);
		});
	}
});
