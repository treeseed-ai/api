import { describe, expect, it } from 'vitest';
import { compileWorkdayAgentProfileSnapshot } from '../../../../../src/api/capacity/services/capacity/workdays/policy/workday-agent-profile-policy.ts';

const permissions = { content: { read: ['book'], write: [] }, tools: ['discussion'] };
const profile = (handler: string) => ({ handler, permissions, prompt: { system: 'Perform this exact bounded activity for the selected project.' } });
const definition = (id: string, agentClass: string, activities: Record<string, unknown>) => ({
	schemaVersion: 'treeseed.agent/v1', id: `sdk/${id}`, name: id, agentClass,
	purpose: `Perform ${id} work.`, responsibilities: [`Own ${id} work.`], capabilities: [`${id}-work`],
	context: { include: ['project-context'] }, activityProfiles: activities,
});
const classes = [
	{ id: 'class-a', slug: 'engineering', status: 'active', handlerRefs: { agents: [definition('architect', 'architect', { planning: profile('writer') })] } },
	{ id: 'class-b', slug: 'assurance', status: 'active', handlerRefs: { agents: [definition('reviewer', 'reviewer', { reviewing: profile('writer') })] } },
];

describe('exact activity selection before living-node admission', () => {
	it('intersects selectors without copying or expanding definitions', () => {
		const result = compileWorkdayAgentProfileSnapshot(classes, { agentSlugs: ['reviewer'], activityTypes: ['reviewing'] });
		expect(result.agents).toHaveLength(1);
		expect(result.agents[0]).toMatchObject({ definition: { id: 'sdk/reviewer' }, activities: ['reviewing'] });
	});
	it('retains unselected definitions once and supports explicit union', () => {
		expect(compileWorkdayAgentProfileSnapshot(classes).agents).toHaveLength(2);
		expect(compileWorkdayAgentProfileSnapshot(classes, { classIds: ['class-a'], agentSlugs: ['reviewer'], mode: 'union' }).agents).toHaveLength(2);
	});
	it('rejects a known but empty intersection', () => {
		expect(() => compileWorkdayAgentProfileSnapshot(classes, { agentSlugs: ['architect'], activityTypes: ['reviewing'] })).toThrowError(/no eligible/u);
	});
	for (const selection of [{ agentSlugs: ['architect', 'typo'] }, { activityTypes: ['reviewng'] }, { classSlugs: ['project:engineering'] }, { classIds: ['missing'], agentSlugs: ['architect'], mode: 'union' }]) {
		it(`rejects unknown selectors even when another selector matches: ${JSON.stringify(selection)}`, () => {
			expect(() => compileWorkdayAgentProfileSnapshot(classes, selection)).toThrowError(/exactly/u);
		});
	}
});
