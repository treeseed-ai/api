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
	it('admits every v2 group subscriber to estimating before a contribution plan exists regardless of class or project', () => {
		const snapshot = (project: string, name: string, groupIds = ['provider-runtime']) => ({ agents: [{
			definition: { ...definition(name, 'maintenance', { planning: profile('writer'), estimating: profile('writer') }), id: `${project}/${name}`, groupIds },
			activities: ['planning', 'estimating'],
		}] });
		const parameters = { groupIds: ['provider-runtime'], agentProfilesByProjectId: {
			agent: snapshot('agent', 'technical-writer'), api: snapshot('api', 'tester'),
			other: snapshot('other', 'engineer', ['another-group']),
		}, proposalsByProjectId: { agent: [{ schemaVersion: 'treeseed.proposal/v2', id: 'opaque-runner', groupIds: ['provider-runtime'] }] } };
		const before = structuredClone(parameters), result = workdayParticipants(parameters);
		expect(result.filter(row => row.activity === 'estimating').map(row => row.definition.id)).toEqual(['agent/technical-writer', 'api/tester']);
		expect(result.filter(row => row.activity === 'planning').map(row => row.definition.id)).toEqual(['agent/technical-writer', 'api/tester']);
		expect(result.every(row => row.proposalId === 'opaque-runner')).toBe(true); expect(parameters).toEqual(before);
	});
	it('rejects hidden agent or allocation-class selectors at the internal snapshot boundary', () => {
		for (const field of ['agentSlugs', 'classIds', 'classSlugs']) {
			expect(() => compileWorkdayAgentProfileSnapshot(classes, { activityTypes: ['planning'], [field]: ['architect'] }))
				.toThrowError(/activity phases/u);
		}
	});
	it('does not import a reporting agent from outside the subscribed group', () => {
		const subscribed = { ...definition('writer', 'documentation', { planning: profile('writer') }), groupIds: ['project-api'] };
		const reporter = { ...definition('reporter', 'reporting', { reporting: profile('reporter') }), groupIds: ['another-project'] };
		const rows = [{ id: 'docs-class', slug: 'documentation', handlerRefs: { agents: [subscribed] } },
			{ id: 'reporting-class', slug: 'reporting', handlerRefs: { agents: [reporter] } }];
		const before = structuredClone(rows);
		expect(compileWorkdayAgentProfileSnapshot(rows, { activityTypes: ['planning'] }, ['project-api']).agents.map(entry => entry.definition.id))
			.toEqual(['sdk/writer']);
		expect(rows).toEqual(before);
	});
	it('retains subscribed identities when their allocation class is paused', () => {
		const rows = classes.map((row, index) => ({ ...row, status: index ? 'paused' : 'active',
			handlerRefs: { agents: row.handlerRefs.agents.map(agent => ({ ...agent, groupIds: ['provider-runtime'] })) } }));
		expect(compileWorkdayAgentProfileSnapshot(rows, undefined, ['provider-runtime']).agents.map(entry => entry.definition.id))
			.toEqual(['sdk/architect', 'sdk/reviewer']);
	});
	it('brings every subscribed project agent to the shared proposal for its own estimate', () => {
		const agents = (project: string, agentClass: string, group = 'portfolio-atlas') => ({ agents: [{
			definition: { ...definition(agentClass, agentClass, { planning: profile('writer'), estimating: profile('estimate') }),
				id: `${project}/${agentClass}`, groupIds: [group] }, activities: ['planning', 'estimating'],
		}] });
		const parameters = { groupIds: ['portfolio-atlas'], agentProfilesByProjectId: {
			ui: agents('ui', 'engineer'), admin: agents('admin', 'engineer'), platform: agents('platform', 'architect'),
			market: agents('market', 'researcher', 'market-research'),
		}, proposalsByProjectId: { ui: [{ schemaVersion: 'treeseed.proposal/v2', id: 'complete-snapshots', groupIds: ['portfolio-atlas'],
			executionPlan: { workItems: [{ id: 'snapshot-replacement', agentClass: 'engineer', review: 'required' }] } }] } };
		const before = structuredClone(parameters), result = workdayParticipants(parameters);
		expect(result.filter(item => item.activity === 'planning').map(item => item.definition.id))
			.toEqual(['admin/engineer', 'platform/architect', 'ui/engineer']);
		expect(result.filter(item => item.activity === 'estimating').map(item => item.definition.id)).toEqual(['admin/engineer', 'platform/architect', 'ui/engineer']);
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
	it('selects activity phases without copying or expanding definitions', () => {
		const result = compileWorkdayAgentProfileSnapshot(classes, { activityTypes: ['reviewing'] });
		expect(result.agents).toHaveLength(1);
		expect(result.agents[0]).toMatchObject({ definition: { id: 'sdk/reviewer' }, activities: ['reviewing'] });
	});
	it('retains all group definitions once and rejects a union targeting escape', () => {
		expect(compileWorkdayAgentProfileSnapshot(classes).agents).toHaveLength(2);
		expect(() => compileWorkdayAgentProfileSnapshot(classes, { classIds: ['class-a'], agentSlugs: ['reviewer'], mode: 'union' })).toThrow(/activity phases/u);
	});
	it('rejects a phase unsupported by the group audience', () => {
		expect(() => compileWorkdayAgentProfileSnapshot(classes, { activityTypes: ['chat'] })).toThrowError(/exactly/u);
	});
	for (const selection of [{ agentSlugs: ['architect', 'typo'] }, { activityTypes: ['reviewng'] }, { classSlugs: ['project:engineering'] }, { classIds: ['missing'], agentSlugs: ['architect'], mode: 'union' }]) {
		it(`rejects unknown selectors even when another selector matches: ${JSON.stringify(selection)}`, () => {
			expect(() => compileWorkdayAgentProfileSnapshot(classes, selection)).toThrowError(/activity phases/u);
		});
	}
});

it('retains subscribed reporting beside cooperative phases without importing other group members',()=>{
 const closeout={...definition('closeout','digest-writer',{reporting:profile('reporter')}),groupIds:['project-api']};
 const rows=[{...classes[0],handlerRefs:{agents:[{...classes[0]!.handlerRefs.agents[0],groupIds:['project-api']}]}},
  {...classes[1],handlerRefs:{agents:[{...classes[1]!.handlerRefs.agents[0],groupIds:['another-project']}]}},
  {id:'class-c',slug:'digest-writer',status:'active',handlerRefs:{agents:[closeout]}}];
 const held=structuredClone(rows),selected=compileWorkdayAgentProfileSnapshot(rows,{activityTypes:['planning']},['project-api']);
 expect(selected.agents.map(entry=>({id:entry.definition.id,activities:entry.activities}))).toEqual([
  {id:'sdk/architect',activities:['planning']},{id:'sdk/closeout',activities:['reporting']}]);
 expect(()=>compileWorkdayAgentProfileSnapshot(rows,{activityTypes:['chat']},['project-api'])).toThrow(/exactly/);
 expect(rows).toEqual(held);
});
