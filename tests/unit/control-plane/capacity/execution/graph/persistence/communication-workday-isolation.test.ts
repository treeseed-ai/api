import { expect, it } from 'vitest';
import { reconcileCommunicationExecutionGraph, persistExecutionGraph } from '../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';
import { digest } from '../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-state.ts';
import { emptyLivingGraph, graphNode, graphProjection, graphState } from '../architecture/living/living-graph-fixture.ts';
import { workdayStartDatabase } from '../../../workdays/scheduling/architecture/workday-start-fixture.ts';

it('discussion reconciliation preserves a live continuation despite the older failed attempt and interrupted reviews', async () => {
	const f = await workdayStartDatabase();
	try {
		const projection = graphProjection(), graph = graphState(projection);
		const actor = graphNode(graph, 'first', 'actor'), reviewer = graphNode(graph, 'next', 'reviewer');
		Object.assign(actor, { status: 'assigned', nodeRevision: 9, workdayId: 'continuation' });
		Object.assign(reviewer, { status: 'failed', nodeRevision: 9, workdayId: 'continuation' });
		graph.digest = digest({ teamId: graph.teamId, nodes: graph.nodes, edges: graph.edges });
		const now = new Date().toISOString();
		await f.query('INSERT INTO capacity_workday_runs (id,team_id,execution_mode,created_at,updated_at) VALUES (?,?,?,?,?)',
			['continuation', 'team', 'simulation', now, now]);
		await persistExecutionGraph(f.store, graph, emptyLivingGraph(), { ...projection.revision, graphDigest: graph.digest });
		for (const [id, node, revision, workday, status] of [
			['old-failed', actor, 7, 'original', 'failed'],
			['live', actor, 9, 'continuation', 'leased'],
			['review-returned', reviewer, 9, 'continuation', 'returned'],
		] as const) await f.query(`INSERT INTO capacity_provider_assignments
			(id,membership_id,team_id,project_id,capacity_provider_id,project_agent_class_id,mode,status,
			execution_node_id,execution_node_revision,work_day_id,assignment_attempt_json,lifecycle_code,created_at,updated_at)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, 'membership', 'team', 'project', 'provider', 'class', 'acting', status,
				node.id, revision, workday, JSON.stringify({ sourceRef: node.sourceRef, authorityRefs: node.authorityRefs }),
				id === 'review-returned' ? 'provider_runtime_recovery' : null, now, now]);
		const before = await f.snapshot();
		for (let retry = 0; retry < 2; retry++) {
			const plan = await reconcileCommunicationExecutionGraph(f.store, 'team', { plan: true });
			expect(plan.changes).toEqual({ added: [], changed: [], completed: [], blocked: [], stale: [], removedEdges: [], addedEdges: [] });
			await reconcileCommunicationExecutionGraph(f.store, 'team');
			expect(await f.snapshot()).toEqual(before);
		}
	} finally { await f.close(); }
}, 30_000);
