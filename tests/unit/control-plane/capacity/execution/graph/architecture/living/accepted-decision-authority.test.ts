import { expect, it } from 'vitest';
import { applyOperationalState } from '../../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-state.ts';
import { graphNode, graphProjection, graphSource, graphState } from './living-graph-fixture.ts';

it('attaches newly accepted Decision authority to never-issued work after the estimating workday closes', () => {
	for (const role of ['actor', 'reviewer'] as const) for (const status of ['proposed', 'blocked', 'ready', 'stale'] as const) {
		const projected = graphState(graphProjection()), current = structuredClone(projected);
		const desired = graphNode(projected, 'first', role), old = graphNode(current, 'first', role);
		old.authorityRefs = old.authorityRefs!.filter(ref => ref.model !== 'decision');
		Object.assign(old, { status, workdayId: 'closed-estimation', nodeRevision: 3 });
		const held = structuredClone({ current, projected }), refreshed = applyOperationalState(current, projected, 4);
		expect(graphNode(refreshed, 'first', role)).toEqual({ ...desired, status: 'stale', workdayId: old.workdayId,
			nodeRevision: 4, graphRevisionCreated: old.graphRevisionCreated, graphRevisionUpdated: 4 });
		expect(applyOperationalState(refreshed, projected, 5).nodes).toEqual(refreshed.nodes);
		const selected = structuredClone(projected); graphNode(selected, 'first', role).workdayId = 'fresh-decision-workday';
		const fresh = graphNode(applyOperationalState(refreshed, selected, 6), 'first', role);
		expect(fresh).toMatchObject({ status: role === 'actor' ? 'ready' : 'blocked', authorityRefs: desired.authorityRefs,
			workdayId: 'fresh-decision-workday', nodeRevision: 5 });
		expect({ current, projected }).toEqual(held);
	}
});

it('never refreshes retired Decision authority for any issued history or ambiguous operational state', () => {
	for (const status of ['proposed', 'blocked', 'ready', 'stale', 'assigned', 'running', 'completed', 'failed', 'cancelled'] as const) {
		for (const issuedHistory of [true, false]) {
			if (!issuedHistory && ['proposed', 'blocked', 'ready', 'stale'].includes(status)) continue;
			const projected = graphState(graphProjection()), current = structuredClone(projected), old = graphNode(current, 'first', 'actor');
			old.authorityRefs = old.authorityRefs!.filter(ref => ref.model !== 'decision');
			Object.assign(old, { status, workdayId: 'closed-estimation', nodeRevision: 3 });
			const result = applyOperationalState(current, projected, 4, new Set(), new Map(), new Map(), new Set(issuedHistory ? [old.id] : []));
			expect(graphNode(result, 'first', 'actor')).toEqual({ ...old, status: 'stale', nodeRevision: status === 'stale' ? 3 : 4,
				graphRevisionUpdated: status === 'stale' ? old.graphRevisionUpdated : 4 });
		}
	}
	for (const changed of [true, false]) {
		const projected = graphState(graphProjection()), current = structuredClone(projected), old = graphNode(current, 'first', 'actor');
		Object.assign(old, { status: 'stale', workdayId: 'closed-estimation', nodeRevision: 3 });
		if (changed) old.authorityRefs = old.authorityRefs!.map(ref => ref.model === 'decision' ? { ...ref, id: 'original-decision' } : ref);
		expect(graphNode(applyOperationalState(current, projected, 4), 'first', 'actor')).toEqual(old);
	}
});

it('does not manufacture Decision authority before approval', () => {
	const source = graphSource(); source.decision = null;
	const projected = graphState(graphProjection([source])), current = structuredClone(projected);
	const old = graphNode(current, 'first', 'actor'); Object.assign(old, { status: 'stale', workdayId: 'closed-estimation' });
	const result = graphNode(applyOperationalState(current, projected, 4), 'first', 'actor');
	expect(result.status).toBe('proposed'); expect(result.authorityRefs?.some(ref => ref.model === 'decision')).toBe(false);
});

it('re-evaluates Decision conditions after a selected workday closes before acting admission', () => {
	for (const priorStatus of ['completed', 'stale'] as const) for (const issued of [true, false]) {
		const projected = graphState(graphProjection()), current = structuredClone(projected);
		const condition = current.nodes.find(node => node.condition?.conditionType === 'authority')!;
		Object.assign(condition, { workdayId: 'closed-before-acting', status: priorStatus, nodeRevision: 3 });
		const actor = graphNode(current, 'first', 'actor');
		Object.assign(actor, { workdayId: 'closed-before-acting', status: 'stale', nodeRevision: 3 });
		const held = structuredClone({ current, projected });
		const next = applyOperationalState(current, projected, 4, new Set(), new Map(), new Map(), new Set(issued ? [actor.id] : []));
		const resolved = next.nodes.find(node => node.id === condition.id)!;
		expect(resolved).toEqual({ ...projected.nodes.find(node => node.id === condition.id), nodeRevision: 4,
			graphRevisionCreated: condition.graphRevisionCreated, graphRevisionUpdated: 4 });
		expect(resolved).not.toHaveProperty('workdayId');
		expect(graphNode(next, 'first', 'actor')).toEqual(actor);
		expect(applyOperationalState(next, projected, 5).nodes).toEqual(next.nodes);
		expect({ current, projected }).toEqual(held);
	}
});

it('does not retain completed authority when current Decision or feedback blocks it', () => {
	for (const reason of ['not-current', 'unresolved-feedback'] as const) {
		const source = graphSource(), current = graphState(graphProjection([source]));
		const old = current.nodes.find(node => node.condition?.conditionType === 'authority')!;
		Object.assign(old, { workdayId: 'closed-before-acting', status: 'completed', nodeRevision: 3 });
		if (reason === 'not-current') source.decision!.current = false;
		else source.feedback = [{ id: 'concern', kind: 'concern', resolved: false, sourceRef: old.sourceRef }];
		const projected = graphState(graphProjection([source]));
		const next = applyOperationalState(current, projected, 4), condition = next.nodes.find(node => node.id === old.id)!;
		expect(condition.status).toBe('blocked'); expect(condition).not.toHaveProperty('workdayId');
		expect(graphNode(next, 'first', 'actor').status).not.toBe('ready');
	}
});
