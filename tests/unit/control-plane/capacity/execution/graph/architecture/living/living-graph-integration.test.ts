import { describe, expect, it } from 'vitest';
import { applyOperationalState, digest, recoverIncompleteReviewCycles } from '../../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-state.ts';
import { emptyLivingGraph, graphNode, graphProjection, graphSource, graphState, livingGraphDatabase } from './living-graph-fixture.ts';

// Authoring only until the complete architecture/assignment test contract is
// present. Embedded SQL transactions are not separate-server concurrency proof.
describe('living graph original SQL and public service integration', () => {
	it('real graph reconciliation denies missing assignable condition and review-pair fields before persistence while retaining exact native condition authority for unchanged replay', async () => {
		const f = await livingGraphDatabase(); try {
			const projection = graphProjection(), original = graphState(projection), held = structuredClone(original);
			await f.persist(original, emptyLivingGraph(), projection.revision); const before = await f.snapshot();
			const fields = ['agentClass', 'estimate', 'requiredCapabilities', 'requestedPermissions', 'workspace'] as const;
			const actor = graphNode(original, 'first', 'actor'), condition = { conditionType: 'lifecycle' as const,
				subjectRef: actor.sourceRef, expectedState: 'workday-closing' };
			const invalid = [
				...fields.map(field => { const value = structuredClone(actor); delete value[field]; return value; }),
				...['workItemId', 'maximumReviewCycles'].map(field => Object.fromEntries(Object.entries(actor).filter(([key]) => key !== field))),
				{ ...actor, condition },
				{ ...actor, kind: 'condition', pairRole: null, condition },
				{ ...Object.fromEntries(Object.entries(actor).filter(([key]) => !fields.some(field => field === key))), kind: 'condition', pairRole: null },
			];
			const supplied = structuredClone(invalid);
			for (const value of invalid) for (let retry = 0; retry < 2; retry++) {
				const candidate = structuredClone(original), index = candidate.nodes.findIndex(node => node.id === actor.id);
				// Deliberately malformed public input must reach the owning schema
				// unchanged, not be normalized by a second test-only validator.
				Object.assign(candidate.nodes[index]!, value);
				for (const key of Object.keys(actor)) if (!Object.hasOwn(value, key)) Reflect.deleteProperty(candidate.nodes[index]!, key);
				expect(() => applyOperationalState(original, candidate, 2)).toThrowError(expect.objectContaining({ status: 422, code: 'execution_graph_invalid' }));
				expect(await f.snapshot()).toEqual(before); expect(await f.service.show(f.principal, 'team', {})).toEqual(original);
			}
			const candidate = structuredClone(original), conditioned = graphNode(candidate, 'first', 'actor');
			conditioned.kind = 'condition'; conditioned.pairRole = null; conditioned.condition = condition;
			for (const field of fields) delete conditioned[field];
			const next = applyOperationalState(original, candidate, 2), nextProjection = graphProjection(undefined, 2);
			await f.persist(next, original, nextProjection.revision);
			expect(await f.service.show(f.principal, 'team', {})).toEqual(next);
			const snapshot = await f.snapshot(); expect(snapshot.assignments).toEqual(before.assignments);
			const replayed = applyOperationalState(next, candidate, 3);
			expect(replayed.nodes).toEqual(next.nodes); expect(await f.snapshot()).toEqual(snapshot);
			expect(original).toEqual(held); expect(invalid).toEqual(supplied);
		} finally { await f.db.close(); }
	});
	it('owning graph reconciliation denies overlong class and duplicated exact node authority before SQL persistence while retaining the original graph for unchanged retry', async () => {
		const f = await livingGraphDatabase(); try {
			const projection = graphProjection(), original = graphState(projection), held = structuredClone(original);
			await f.persist(original, emptyLivingGraph(), projection.revision); const before = await f.snapshot();
			const actor = graphNode(original, 'first', 'actor'), ref = actor.authorityRefs![0]!;
			const invalid = [{ agentClass: 'a'.repeat(101) }, { agentClass: ' padded' }, { agentClass: 'padded ' },
				{ authorityRefs: [ref, structuredClone(ref)] }, { authorityRefs: [ref, Object.fromEntries(Object.entries(ref).reverse())] }];
			const supplied = structuredClone(invalid);
			for (const patch of invalid) for (let retry = 0; retry < 2; retry++) {
				const candidate = structuredClone(original); Object.assign(graphNode(candidate, 'first', 'actor'), patch);
				expect(() => applyOperationalState(original, candidate, 2)).toThrowError(expect.objectContaining({ status: 422, code: 'execution_graph_invalid' }));
				expect(await f.snapshot()).toEqual(before); expect(await f.service.show(f.principal, 'team', {})).toEqual(original);
			}
			const candidate = structuredClone(original); graphNode(candidate, 'first', 'actor').agentClass = 'a'.repeat(100);
			const next = applyOperationalState(original, candidate, 2), nextProjection = graphProjection(undefined, 2);
			await f.persist(next, original, nextProjection.revision);
			expect(await f.service.show(f.principal, 'team', {})).toEqual(next);
			const snapshot = await f.snapshot(); expect(snapshot.revisions).toHaveLength(2); expect(snapshot.assignments).toEqual(before.assignments);
			expect(applyOperationalState(next, candidate, 3).nodes).toEqual(next.nodes);
			expect(await f.snapshot()).toEqual(snapshot); expect(original).toEqual(held); expect(invalid).toEqual(supplied);
		} finally { await f.db.close(); }
	});
	it('native owning SQL preserves optional safe integer priorities and exact dependency provenance while invalid writes retain the complete graph', async () => {
		const f = await livingGraphDatabase();
		try {
			const p = graphProjection(), graph = graphState(p), priorities = [Number.MIN_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER];
			graph.nodes.slice(0, 3).forEach((node, index) => { node.priority = priorities[index]!; });
			const edge = graph.edges[0]!; edge.provenance = 'treedx-link'; edge.sourceRef = graph.nodes[0]!.sourceRef;
			graph.digest = digest({ teamId: graph.teamId, nodes: graph.nodes, edges: graph.edges });
			const held = structuredClone(graph); await f.persist(graph, emptyLivingGraph(), p.revision);
			expect(await f.service.show(f.principal, 'team', {})).toEqual(graph); expect(graph).toEqual(held);
			const snapshot = await f.snapshot();
			for (const priority of ['9007199254740992', '-9007199254740992', '1.5', 'invalid']) {
				await expect(f.query('UPDATE execution_nodes SET priority=? WHERE id=?', [priority, graph.nodes[0]!.id])).rejects.toThrow();
				expect(await f.snapshot()).toEqual(snapshot);
			}
			await expect(f.query('UPDATE execution_edges SET provenance=? WHERE id=?', ['invented-policy', edge.id])).rejects.toThrow();
			expect(await f.snapshot()).toEqual(snapshot);
			const changed = structuredClone(graph); delete changed.nodes[0]!.priority; changed.nodes[0]!.graphRevisionUpdated = 2; changed.revision = 2;
			changed.digest = digest({ teamId: changed.teamId, nodes: changed.nodes, edges: changed.edges });
			const next = graphProjection(undefined, 2); await f.persist(changed, graph, next.revision);
			expect(await f.service.show(f.principal, 'team', {})).toEqual(changed);
			expect((await f.query('SELECT priority FROM execution_nodes WHERE id=?', [graph.nodes[0]!.id])).rows).toEqual([{ priority: null }]);
			expect((await f.snapshot()).revisions).toHaveLength(2); expect(graph).toEqual(held);
		} finally { await f.db.close(); }
	});
	it('persists one team graph with independent reviewed dependencies and exact provenance readback', async () => {
		const f = await livingGraphDatabase();
		try {
			const projection = graphProjection([graphSource(), graphSource('second')]), graph = graphState(projection), before = structuredClone(projection);
			await f.persist(graph, emptyLivingGraph(), projection.revision);
			const observed = await f.service.show(f.principal, 'team', {});
			expect(observed).toEqual(graph); expect(projection).toEqual(before);
			for (const projectId of ['project', 'second']) {
				const view = await f.service.show(f.principal, 'team', { projectId });
				expect(view.nodes).toEqual(graph.nodes.filter(node => node.projectId === projectId));
				const next = graphNode(graph, 'next', 'actor', projectId), review = graphNode(graph, 'first', 'reviewer', projectId);
				const explanation = await f.service.explain(f.principal, 'team', next.id);
				expect(explanation.admission.eligible).toBe(false);
				expect(explanation.predecessors.filter((value: { edge: { fromNodeId: string } }) => value.edge.fromNodeId === review.id)
					.map((value: { edge: { provenance: string } }) => value.edge.provenance).sort()).toEqual(['profile-agent', 'work-item']);
			}
		} finally { await f.db.close(); }
	});
	it('releases downstream SQL readiness only after independent reviewer completion and preserves the prior candidate', async () => {
		const f = await livingGraphDatabase();
		try {
			const initialProjection = graphProjection(), initial = graphState(initialProjection);
			await f.persist(initial, emptyLivingGraph(), initialProjection.revision);
			const actorCompleted = structuredClone(initial); graphNode(actorCompleted, 'first', 'actor').status = 'completed';
			const waitingProjection = graphProjection(undefined, 2), waiting = graphState(waitingProjection, actorCompleted);
			await f.persist(waiting, initial, waitingProjection.revision);
			expect((await f.service.node(f.principal, 'team', graphNode(waiting, 'next', 'actor').id)).status).toBe('blocked');
			expect((await f.service.node(f.principal, 'team', graphNode(waiting, 'first', 'reviewer').id)).status).toBe('ready');
			const approved = structuredClone(waiting); graphNode(approved, 'first', 'reviewer').status = 'completed';
			const finalProjection = graphProjection(undefined, 3), next = graphState(finalProjection, approved);
			await f.persist(next, waiting, finalProjection.revision);
			expect((await f.service.explain(f.principal, 'team', graphNode(next, 'next', 'actor').id)).admission.eligible).toBe(true);
			expect(graphNode(next, 'first', 'actor')).toEqual(graphNode(waiting, 'first', 'actor'));
		} finally { await f.db.close(); }
	});
	it('read-only node explanation filtered views repeated reads and watch cursors never mutate owning SQL', async () => {
		const f = await livingGraphDatabase();
		try {
			const p = graphProjection(), graph = graphState(p); await f.persist(graph, emptyLivingGraph(), p.revision);
			const before = await f.snapshot();
			await Promise.all([f.service.show(f.principal, 'team', {}), f.service.show(f.principal, 'team', { decisionId: 'project-decision' }),
				f.service.node(f.principal, 'team', graphNode(graph, 'first', 'actor').id), f.service.explain(f.principal, 'team', graphNode(graph, 'next', 'actor').id)]);
			const first = await f.service.watch(f.principal, 'team', { cursor: '0', limit: 1 });
			expect(first.items).toHaveLength(1); expect(first.nextCursor).toBe('1');
			expect(await f.service.watch(f.principal, 'team', { cursor: first.nextCursor, limit: 1 })).toEqual({ items: [], nextCursor: '1' });
			expect(await f.snapshot()).toEqual(before);
		} finally { await f.db.close(); }
	});
	it('denies missing principal and foreign team node lookup with unchanged graph and assignments', async () => {
		const f = await livingGraphDatabase();
		try {
			const p = graphProjection(), graph = graphState(p); await f.persist(graph, emptyLivingGraph(), p.revision);
			const before = await f.snapshot(), id = graphNode(graph, 'first', 'actor').id;
			await expect(f.service.show(undefined, 'team', {})).rejects.toMatchObject({ status: 401 });
			await expect(f.service.node(f.principal, 'other-team', id)).rejects.toMatchObject({ status: 404 });
			expect(await f.service.show(f.principal, 'other-team', {})).toMatchObject({ nodes: [], edges: [], revision: 0 });
			expect(await f.snapshot()).toEqual(before);
		} finally { await f.db.close(); }
	});
	it('rejects stale competing revision writers without overwriting the winning graph or appending duplicate history', async () => {
		const f = await livingGraphDatabase();
		try {
			const p = graphProjection(), graph = graphState(p); await f.persist(graph, emptyLivingGraph(), p.revision);
			const leftSource = graphSource(); leftSource.decision = null;
			const leftProjection = graphProjection([leftSource], 2), left = graphState(leftProjection, graph);
			const rightSource = graphSource(); rightSource.proposalRevision = 2; rightSource.digest = `sha256:${'d'.repeat(64)}`;
			const rightProjection = graphProjection([rightSource], 2), right = graphState(rightProjection, graph);
			const attempts = await Promise.allSettled([f.persist(left, graph, leftProjection.revision), f.persist(right, graph, rightProjection.revision)]);
			expect(attempts.filter(value => value.status === 'fulfilled')).toHaveLength(1);
			expect(attempts.filter(value => value.status === 'rejected')).toHaveLength(1);
			const winner = await f.service.show(f.principal, 'team', {}), snapshot = await f.snapshot();
			expect(winner.revision).toBe(2); expect(snapshot.revisions).toHaveLength(2);
			const losing = winner.digest === left.digest ? right : left, losingReceipt = winner.digest === left.digest ? rightProjection.revision : leftProjection.revision;
			await expect(f.persist(losing, graph, losingReceipt)).rejects.toMatchObject({ code: 'execution_graph_revision_conflict' });
			expect(await f.snapshot()).toEqual(snapshot);
		} finally { await f.db.close(); }
	});
	it('rolls back a late SQL edge failure and retries the exact projection without orphan nodes or revision residue', async () => {
		const f = await livingGraphDatabase();
		try {
			const p = graphProjection(), graph = graphState(p), before = await f.snapshot();
			await f.db.exec("CREATE FUNCTION reject_graph_edge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated late edge interruption'; END $$; CREATE TRIGGER reject_graph_edge BEFORE INSERT ON execution_edges FOR EACH ROW EXECUTE FUNCTION reject_graph_edge();");
			await expect(f.persist(graph, emptyLivingGraph(), p.revision)).rejects.toThrow('isolated late edge interruption');
			expect(await f.snapshot()).toEqual(before);
			await f.db.exec('DROP TRIGGER reject_graph_edge ON execution_edges; DROP FUNCTION reject_graph_edge();');
			await f.persist(graph, emptyLivingGraph(), p.revision);
			expect(await f.service.show(f.principal, 'team', {})).toEqual(graph);
			const duplicates = await f.query('SELECT from_node_id,to_node_id,provenance,COUNT(*) FROM execution_edges GROUP BY from_node_id,to_node_id,provenance HAVING COUNT(*)>1');
			expect(duplicates.rows).toEqual([]);
		} finally { await f.db.close(); }
	});
	it('persists a bounded request-changes revision on the same pair without unblocking downstream or modifying assignment history', async () => {
		const f = await livingGraphDatabase();
		try {
			const p = graphProjection(), initial = graphState(p); await f.persist(initial, emptyLivingGraph(), p.revision);
			const rejected = structuredClone(initial), actor = graphNode(rejected, 'first', 'actor'), review = graphNode(rejected, 'first', 'reviewer');
			actor.status = 'completed'; review.status = 'failed'; const assignmentHistory = (await f.snapshot()).assignments;
			const next = recoverIncompleteReviewCycles(rejected, new Map([[review.id, 1]]), new Set([review.id]), 2);
			const nextProjection = graphProjection(undefined, 2); next.revision = 2;
			await f.persist(next, initial, nextProjection.revision);
			expect(await f.service.node(f.principal, 'team', actor.id)).toMatchObject({ status: 'ready', nodeRevision: 2, workItemId: 'first' });
			expect(await f.service.node(f.principal, 'team', review.id)).toMatchObject({ status: 'blocked', nodeRevision: 2, workItemId: 'first' });
			expect((await f.service.node(f.principal, 'team', graphNode(next, 'next', 'actor').id)).status).toBe('blocked');
			expect((await f.snapshot()).assignments).toEqual(assignmentHistory);
		} finally { await f.db.close(); }
	});
});
