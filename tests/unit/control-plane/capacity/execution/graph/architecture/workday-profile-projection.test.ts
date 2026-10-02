import { describe, expect, it } from 'vitest';
import { profile, project, reconcile } from './workday-profile-fixture.ts';

describe('governed activity lifecycle projection', () => {
	it('projects reporting from a governed profile independently of the agent class name', () => {
		for (const name of ['reporter', 'closeout-author']) {
			const definition = profile(name);
			const graph = project([definition]);
			expect(graph.nodes.filter(node => node.kind === 'reporting')).toEqual([
				expect.objectContaining({ agentClass: name, requestedPermissions: definition.activityProfiles.reporting!.permissions,
					workspace: 'treedx', status: 'blocked' }),
			]);
			const report = graph.nodes.find(node => node.kind === 'reporting')!;
			const condition = graph.nodes.find(node => node.kind === 'condition')!;
			expect(condition.condition).toMatchObject({ conditionType: 'lifecycle', expectedState: 'closing' });
			expect(graph.edges.filter(edge => edge.toNodeId === report.id)).toEqual([
				expect.objectContaining({ fromNodeId: condition.id, provenance: 'profile-event' }),
			]);
		}
	});

	it('rejects ambiguous closeout selection instead of manufacturing multiple workday reports', () => {
		expect(() => project([profile('closeout-author'), profile('audit-author')]))
			.toThrow(/report|closeout|select|ambiguous/iu);
	});

	it('never invents a reporting lifecycle dependency from an agent name or another activity', () => {
		for (const planningClosing of [false, true]) {
			const graph = project([profile('reporter', { closing: false, planningClosing })]);
			const report = graph.nodes.find(node => node.kind === 'reporting')!;
			expect(report).toBeDefined();
			expect(graph.edges.filter(edge => edge.toNodeId === report.id && edge.provenance === 'profile-event')).toEqual([]);
		}
	});

	it('applies a declared lifecycle dependency only to its scheduled activity', () => {
		const graph = project([profile('planner', { reporting: false, planningClosing: true })]);
		const planning = graph.nodes.find(node => node.kind === 'planning')!;
		const condition = graph.nodes.find(node => node.kind === 'condition');
		expect(condition).toMatchObject({ status: 'blocked', condition: { conditionType: 'lifecycle', expectedState: 'closing' } });
		expect(graph.edges).toContainEqual(expect.objectContaining({ fromNodeId: condition!.id,
			toNodeId: planning.id, provenance: 'profile-event' }));
		expect(reconcile(graph).nodes.find(node => node.id === planning.id)?.status).toBe('blocked');
		expect(reconcile(project([profile('planner', { reporting: false, planningClosing: true })], 'closing'))
			.nodes.find(node => node.id === planning.id)?.status).toBe('ready');
	});

	it('does not manufacture reporting work for disabled profiles or mutate governed profile bytes', () => {
		const definition = profile('reporter', { reporting: false });
		const before = JSON.stringify(definition);
		const first = project([definition]);
		expect(first.nodes.some(node => node.kind === 'reporting')).toBe(false);
		expect(project([definition])).toEqual(first);
		expect(JSON.stringify(definition)).toBe(before);
	});
});
