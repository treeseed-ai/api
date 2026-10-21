import { describe, expect, it } from 'vitest';
import { compileWorkdayAgentProfileSnapshot } from '../../../../../src/api/capacity/services/capacity/workdays/policy/workday-agent-profile-policy.ts';
import { workdayParticipants } from '../../../../../src/api/capacity/policy/execution/workday-participants.ts';

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
	it('brings subscribed project teams to the same proposal while estimates stay with its owning project', () => {
		const agents = (project: string, agentClass: string, group = 'portfolio-atlas') => ({ agents: [{
			definition: { ...definition(agentClass, agentClass, { planning: profile('writer'), estimating: profile('estimate') }),
				id: `${project}/${agentClass}`, groupIds: [group] }, activities: ['planning', 'estimating'],
		}] });
		const parameters = { groupIds: ['portfolio-atlas'], agentProfilesByProjectId: {
			ui: agents('ui', 'engineer'), admin: agents('admin', 'engineer'), platform: agents('platform', 'architect'),
			market: agents('market', 'researcher', 'market-research'),
		}, proposalsByProjectId: { ui: [{ id: 'complete-snapshots', groupIds: ['portfolio-atlas'],
			executionPlan: { workItems: [{ id: 'snapshot-replacement', agentClass: 'engineer', review: 'required' }] } }] } };
		const before = structuredClone(parameters), result = workdayParticipants(parameters);
		expect(result.filter(item => item.activity === 'planning').map(item => item.definition.id))
			.toEqual(['admin/engineer', 'platform/architect', 'ui/engineer']);
		expect(result.filter(item => item.activity === 'estimating').map(item => item.definition.id)).toEqual(['ui/engineer']);
		expect(result.every(item => item.proposalId === 'complete-snapshots')).toBe(true);
		expect(parameters).toEqual(before);
	});
	it('selects every subscribed project agent across classes while leaving unrelated agents out', () => {
		const rows = ['architect', 'engineer', 'reviewer', 'researcher'].map((agentClass, index) => ({
			id: `class-${index}`, slug: agentClass, status: 'active', handlerRefs: { agents: [{
				...definition(agentClass, agentClass, { planning: profile('writer') }),
				groupIds: [agentClass === 'researcher' ? 'market-research' : 'ui-snapshot-admin-chart'],
			}] },
		}));
		const held = structuredClone(rows);
		const result = compileWorkdayAgentProfileSnapshot(rows, undefined, ['ui-snapshot-admin-chart']);
		expect(result.agents.map(entry => entry.definition.id)).toEqual(['sdk/architect', 'sdk/engineer', 'sdk/reviewer']);
		expect(() => compileWorkdayAgentProfileSnapshot(rows, undefined, ['unknown-group'])).toThrow(/no eligible/u);
		expect(rows).toEqual(held);
	});
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

it('retains one standing reporting activity beside an exact cooperative selection without changing selected planning work or admitting an empty intersection',()=>{
 const closeout=definition('closeout','digest-writer',{planning:profile('writer'),reporting:profile('reporter')}),rows=[...classes,{id:'class-c',slug:'digest-writer',status:'active',handlerRefs:{agents:[closeout]}}],held=structuredClone(rows);
 const selected=compileWorkdayAgentProfileSnapshot(rows,{agentSlugs:['architect'],activityTypes:['planning']});
 expect(selected.agents.map(entry=>({id:entry.definition.id,activities:entry.activities}))).toEqual([{id:'sdk/architect',activities:['planning']},{id:'sdk/closeout',activities:['reporting']}]);
 expect(()=>compileWorkdayAgentProfileSnapshot(rows,{agentSlugs:['architect'],activityTypes:['reviewing']})).toThrow(/no eligible/);expect(rows).toEqual(held);
});
