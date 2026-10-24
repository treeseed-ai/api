import { expect, it } from 'vitest';
import type { ExecutionNode } from '@treeseed/sdk/agent-capacity';
import { applyOperationalState } from '../../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-state.ts';
import { emptyLivingGraph, graphNode, graphProjection, graphState, livingGraphDatabase } from './living-graph-fixture.ts';

it('preserves newer admitted rework over historical review return during repeated reconciliation', () => {
	for (const role of ['actor', 'reviewer'] as const) for (const status of ['assigned', 'running'] as const) for (const terminalRevision of [3, 5]) {
		const current = graphState(graphProjection()), target = graphNode(current, 'first', role);
		Object.assign(target, { status, nodeRevision: 5, workdayId: 'continuation' });
		const terminal = new Map([[target.id, { status: role === 'actor' ? 'ready' as const : 'blocked' as const, nodeRevision: terminalRevision }]]);
		const projected = graphState(graphProjection(undefined, 2));
		graphNode(projected, 'first', role).workdayId = 'continuation';
		const original = structuredClone({ current, projected, terminal }), active = new Set([target.id]);
		const next = applyOperationalState(current, projected, 2, active, terminal);
		expect(graphNode(next, 'first', role)).toEqual(target);
		expect(applyOperationalState(next, projected, 3, active, terminal).nodes).toEqual(next.nodes);
		expect({ current, projected, terminal }).toEqual(original);
		// Without the newer active attempt, history still governs the projection.
		expect(graphNode(applyOperationalState(current, projected, 2, new Set(), terminal), 'first', role).status)
			.toBe(role === 'actor' ? 'ready' : 'blocked');
		for (const terminalStatus of ['failed', 'cancelled'] as const) {
			const terminal = new Map([[target.id, { status: terminalStatus, nodeRevision: 5 }]]);
			expect(graphNode(applyOperationalState(current, projected, 2, active, terminal), 'first', role).status).toBe(terminalStatus);
		}
	}
});

it('persists running rework through native graph reconciliation so exact lifecycle closeout remains admissible', async () => {
	for (const role of ['actor', 'reviewer'] as const) {
	const f = await livingGraphDatabase();
	try {
		const initial = graphState(graphProjection()), actor = graphNode(initial, 'first', 'actor'), target=graphNode(initial,'first',role);
		Object.assign(actor, { status: role==='reviewer'?'completed':'running', nodeRevision: 5 });
		Object.assign(target, { status:'running',nodeRevision:5 });
		await f.persist(initial, emptyLivingGraph(), graphProjection().revision);
		const projected = graphState(graphProjection(undefined, 2));
		const history=new Map<string,{status:ExecutionNode['status'];nodeRevision:number}>([[target.id,{status:role==='actor'?'ready':'blocked',nodeRevision:5}]]);
		if(role==='reviewer')history.set(actor.id,{status:'completed',nodeRevision:5});
		const next = applyOperationalState(initial, projected, 2, new Set([target.id]),history);
		await f.persist(next, initial, graphProjection(undefined, 2).revision);
		expect(await f.service.node(f.principal, 'team', target.id)).toMatchObject({ status: 'running', nodeRevision: 5 });
		const eligible = await f.query("SELECT id FROM execution_nodes WHERE id=$1 AND team_id=$2 AND node_revision=$3 AND status IN ('assigned','running')", [target.id, 'team', 5]);
		expect(eligible.rows.map(value => value.id)).toEqual([target.id]);
		expect(graphNode(next, 'first', role==='actor'?'reviewer':'actor').status).toBe(role==='actor'?'blocked':'completed');
	} finally { await f.db.close(); }
	}
});
