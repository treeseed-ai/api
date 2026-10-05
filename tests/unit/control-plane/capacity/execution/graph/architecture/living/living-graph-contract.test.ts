import { describe, expect, it } from 'vitest';
import { projectTeamExecutionGraph } from '../../../../../../../../src/api/capacity/policy/execution/execution-graph-projector.ts';
import { applyOperationalState, recoverIncompleteReviewCycles } from '../../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-state.ts';
import { decodeExecutionNode } from '../../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-storage.ts';
import { persistExecutionGraph } from '../../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';
import { emptyLivingGraph, graphNode, graphProfiles, graphProjection, graphSource, graphState } from './living-graph-fixture.ts';

describe('complete governed living graph contract authoring', () => {
	it('reconciles every recovered terminal pair priority without changing issued node authority or reopening terminal history', () => {
		for (const role of ['actor', 'reviewer'] as const) for (const status of ['completed', 'failed', 'cancelled', 'blocked'] as const) {
			if (role === 'actor' && status === 'blocked') continue;
			const input = graphProjection(), current = graphState(input), target = graphNode(current, 'first', role);
			const actor = graphNode(current, 'first', 'actor');
			const terminal = new Map([[actor.id, { status: 'completed' as const, nodeRevision: actor.nodeRevision }],
				[target.id, { status, nodeRevision: target.nodeRevision }]]);
			const original = structuredClone({ current, input, terminal });
			let retained = applyOperationalState(current, { ...current, nodes: input.nodes, edges: input.edges }, 1, new Set(), terminal);
			const frozen = structuredClone(graphNode(retained, 'first', role));
			for (const priority of [Number.MIN_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER, undefined]) {
				const projected = graphProjection(undefined, retained.revision + 1);
				const node = projected.nodes.find(value => value.id === target.id)!;
				if (priority !== undefined) node.priority = priority;
				const candidate = { ...retained, nodes: projected.nodes, edges: projected.edges };
				const held = structuredClone({ retained, projected, terminal });
				const next = applyOperationalState(retained, candidate, projected.revision.revision, new Set(), terminal);
				const { priority: _priority, graphRevisionUpdated: _revision, ...authority } = frozen;
				expect(graphNode(next, 'first', role)).toEqual({ ...authority, ...(priority === undefined ? {} : { priority }), graphRevisionUpdated: next.revision });
				expect(next.digest).not.toBe(retained.digest);
				expect(next.edges).toEqual(retained.edges);
				expect(applyOperationalState(next, candidate, next.revision, new Set(), terminal)).toEqual(next);
				expect({ retained, projected, terminal }).toEqual(held);
				retained = next;
			}
			expect({ current, input, terminal }).toEqual(original);
		}
	});
	it('binds every graph mutation to its exact winning digest even when competing revisions share the same publication clock', async () => {
		const projection = graphProjection(), original = graphState(projection);
		for (const current of [emptyLivingGraph(), original]) {
			const graph = current.revision === 0 ? original : { ...original, revision: 2, digest: 'different-desired-digest', edges: [] };
			const receipt = { ...projection.revision, revision: graph.revision, graphDigest: graph.digest };
			const before = structuredClone({ graph, current, receipt });
			let operations: Array<{ query: string; params: unknown[] }> = [];
			const store = {
				batch: async (values: typeof operations) => { operations = structuredClone(values); },
				first: async () => ({ revision: graph.revision, graph_digest: 'retained-competing-digest' }),
			};
			await expect(persistExecutionGraph(store, graph, current, receipt)).rejects.toMatchObject({ status: 409, code: 'execution_graph_revision_conflict' });
			const mutations = operations.filter(value => /^(INSERT INTO execution_nodes|INSERT INTO execution_edges|UPDATE execution_edges)/.test(value.query));
			expect(mutations.length).toBeGreaterThan(0);
			for (const mutation of mutations) {
				expect(mutation.query).toContain('WHERE team_id=? AND revision=? AND created_at=? AND graph_digest=?');
				expect(mutation.params.slice(-4)).toEqual([receipt.teamId, receipt.revision, receipt.createdAt, receipt.graphDigest]);
			}
			expect({ graph, current, receipt }).toEqual(before);
		}
	});
	it('decodes exact persisted safe integer priority without coercing malformed storage or inventing omitted authority', () => {
		const node = graphNode(graphState(graphProjection()), 'first', 'actor');
		const row = { id: node.id, team_id: node.teamId, project_id: node.projectId, work_item_id: node.workItemId,
			kind: node.kind, pair_role: node.pairRole, source_ref_json: JSON.stringify(node.sourceRef), authority_refs_json: JSON.stringify(node.authorityRefs),
			rule_revision: node.ruleRevision, node_revision: node.nodeRevision, agent_class: node.agentClass, status: node.status,
			estimate_json: JSON.stringify(node.estimate), required_capabilities_json: JSON.stringify(node.requiredCapabilities),
			requested_permissions_json: JSON.stringify(node.requestedPermissions), output_json: JSON.stringify(node.output), workspace: node.workspace,
			acceptance_criteria_json: JSON.stringify(node.acceptanceCriteria), maximum_review_cycles: node.maximumReviewCycles,
			graph_revision_created: node.graphRevisionCreated, graph_revision_updated: node.graphRevisionUpdated };
		const before = structuredClone(row);
		for (const priority of [Number.MIN_SAFE_INTEGER, -1, 0, 1, Number.MAX_SAFE_INTEGER]) {
			for (const stored of [priority, String(priority)]) expect(decodeExecutionNode({ ...row, priority: stored })).toEqual({ ...node, priority });
		}
		expect(decodeExecutionNode(row)).toEqual(node); expect(decodeExecutionNode({ ...row, priority: null })).toEqual(node);
		for (const priority of ['', ' ', '1.0', '1e0', '+1', '01', false, [], {}, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '9007199254740992']) {
			const input = { ...row, priority }, held = structuredClone(input);
			expect(() => decodeExecutionNode(input)).toThrow(); expect(input).toEqual(held);
		}
		expect(row).toEqual(before);
	});
	it('projects governed work-item integer priorities unchanged onto both review-pair nodes without bypassing approval dependencies or permission ceilings', () => {
		for (const priority of [Number.MIN_SAFE_INTEGER, -1, 0, 1, Number.MAX_SAFE_INTEGER]) {
			const source = graphSource(), plan = source.frontmatter.executionPlan;
			if (!plan || typeof plan !== 'object' || !('workItems' in plan) || !Array.isArray(plan.workItems)) throw new Error('Original proposal work items required');
			for (const item of plan.workItems) Object.assign(item, { priority });
			const held = structuredClone(source), projected = graphProjection([source]), graph = graphState(projected);
			for (const item of graph.nodes.filter(node => node.workItemId)) expect(item).toMatchObject({ priority });
			expect(graphNode(graph, 'first', 'reviewer').status).toBe('blocked'); expect(graphNode(graph, 'next', 'actor').status).toBe('blocked');
			const omitted = graphState(graphProjection());
			for (const item of graph.nodes.filter(node => node.workItemId)) {
				const { priority: _priority, ...raw } = Object.assign({}, item, { priority });
				expect(raw).toEqual(omitted.nodes.find(node => node.id === item.id));
			}
			expect(source).toEqual(held);
			const unapproved = { ...source, decision: null }; expect(graphProjection([unapproved]).nodes.filter(node => node.workItemId).every(node => node.status === 'proposed')).toBe(true);
		}
		for (const priority of [null, '', '1', false, [], {}, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
			const source = graphSource(), plan = source.frontmatter.executionPlan;
			if (!plan || typeof plan !== 'object' || !('workItems' in plan) || !Array.isArray(plan.workItems)) throw new Error('Original proposal work items required');
			Object.assign(plan.workItems[0], { priority }); const held = structuredClone(source);
			expect(() => graphProjection([source])).toThrow(); expect(source).toEqual(held);
		}
		const denied = graphSource(), plan = denied.frontmatter.executionPlan;
		if (!plan || typeof plan !== 'object' || !('workItems' in plan) || !Array.isArray(plan.workItems)) throw new Error('Original proposal work items required');
		Object.assign(plan.workItems[0], { priority: Number.MAX_SAFE_INTEGER, requestedPermissions: { content: { read: ['proposal'], write: [] }, tools: ['release'] } });
		expect(() => graphProjection([denied])).toThrow();
	});
	it('binds changed canonical priority to the same semantic node revision while preserving running authority blocked dependencies and exact replay', () => {
		const projected = graphProjection(), input = { ...projected, nodes: projected.nodes.map(node => Object.assign({}, node, { priority: 0 })) };
		const before = structuredClone(input), current = graphState(input), actor = graphNode(current, 'first', 'actor');
		const later = graphProjection(undefined, 2), changed = { ...later, nodes: later.nodes.map(node => Object.assign({}, node, { priority: node.id === actor.id ? 10 : 0 })) };
		const held = structuredClone(changed), next = graphState(changed, current);
		expect(graphNode(next, 'first', 'actor')).toEqual({ ...actor, priority: 10, nodeRevision: actor.nodeRevision + 1, graphRevisionUpdated: 2 });
		expect(graphNode(next, 'first', 'reviewer').status).toBe('blocked'); expect(graphNode(next, 'next', 'actor').status).toBe('blocked');
		expect(next.digest).not.toBe(current.digest); expect(next.nodes.map(node => node.id)).toEqual(current.nodes.map(node => node.id));
		expect(next.edges).toEqual(current.edges); expect(graphState(changed, next)).toEqual(next);
		const running = structuredClone(current); graphNode(running, 'first', 'actor').status = 'running';
		const frozen = structuredClone(graphNode(running, 'first', 'actor'));
		// Human resolution: mutable scheduling priority is not issued attempt authority.
		const runningBefore = structuredClone(running), active = new Set([actor.id]);
		const reprioritized = graphState(changed, running, active);
		expect(graphNode(reprioritized, 'first', 'actor')).toEqual({ ...frozen, priority: 10, graphRevisionUpdated: 2 });
		expect(graphState(changed, reprioritized, active)).toEqual(reprioritized);
		const cleared = structuredClone(changed);
		const projectedActor = cleared.nodes.find(node => node.id === actor.id); if (!projectedActor) throw new Error('Original projected Actor required');
		delete projectedActor.priority; const removed = graphState(cleared, reprioritized, active);
		const { priority: _priority, ...omitted } = frozen;
		expect(graphNode(removed, 'first', 'actor')).toEqual({ ...omitted, graphRevisionUpdated: 2 });
		expect(graphState(cleared, removed, active)).toEqual(removed); expect(running).toEqual(runningBefore);
		for (const priority of [null, '', '1', false, {}, [], 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
			const invalid = { ...projected, nodes: projected.nodes.map(node => Object.assign({}, node, { priority })) }, original = structuredClone(invalid);
			expect(() => graphState(invalid, current)).toThrow(); expect(invalid).toEqual(original); expect(current).toEqual(graphState(input));
		}
		expect(input).toEqual(before); expect(changed).toEqual(held);
		// Priority changes ranking, not identity, dependencies, grants or a live
		// assignment's frozen authority. This is the original pure state boundary.
	});
	it('unions profile and work-item provenance without allowing actor completion to bypass independent review', () => {
		const projected = graphProjection(), current = graphState(projected), before = structuredClone(projected);
		const first = graphNode(current, 'first', 'actor'), review = graphNode(current, 'first', 'reviewer'), next = graphNode(current, 'next', 'actor');
		expect(current.edges.filter(edge => edge.fromNodeId === review.id && edge.toNodeId === next.id).map(edge => edge.provenance).sort()).toEqual(['profile-agent', 'work-item']);
		first.status = 'completed'; const awaiting = graphState(graphProjection(undefined, 2), current);
		expect(graphNode(awaiting, 'first', 'reviewer').status).toBe('ready'); expect(graphNode(awaiting, 'next', 'actor').status).toBe('blocked');
		graphNode(awaiting, 'first', 'reviewer').status = 'completed';
		expect(graphNode(graphState(graphProjection(undefined, 3), awaiting), 'next', 'actor').status).toBe('ready');
		expect(projected).toEqual(before);
	});
	it('rejects cycles missing work items denied permissions and foreign team inputs without changing sources', () => {
		const outcomes: boolean[] = [];
		for (const change of [
			(source: ReturnType<typeof graphSource>) => { source.teamId = 'other-team'; },
			(source: ReturnType<typeof graphSource>) => { const plan = source.frontmatter.executionPlan as { workItems: Array<{ dependsOn: string[] }> }; plan.workItems[0]!.dependsOn = ['next']; },
			(source: ReturnType<typeof graphSource>) => { const plan = source.frontmatter.executionPlan as { workItems: Array<{ dependsOn: string[] }> }; plan.workItems[1]!.dependsOn = ['missing']; },
			(source: ReturnType<typeof graphSource>) => { const plan = source.frontmatter.executionPlan as { workItems: Array<{ requestedPermissions: { tools: string[] } }> }; plan.workItems[0]!.requestedPermissions.tools = ['release']; },
		]) {
			const source = graphSource(); change(source); const before = structuredClone(source);
			try { graphProjection([source]); outcomes.push(false); } catch { outcomes.push(true); }
			expect(source).toEqual(before);
		}
		expect(outcomes).toEqual([true, true, true, true]);
	});
	it('preserves all running node authority while changed source creates a later immutable revision', () => {
		const current = graphState(graphProjection()), running = graphNode(current, 'first', 'actor'); running.status = 'running';
		const before = structuredClone(running), source = graphSource(); source.commit = 'd'.repeat(40); source.proposalRevision = 2; source.digest = `sha256:${'e'.repeat(64)}`;
		const next = graphState(graphProjection([source], 2), current, new Set([running.id]));
		expect(next.nodes.find(node => node.id === running.id)).toMatchObject({ ...before, graphRevisionUpdated: 2 });
		expect(next.nodes.some(node => node.workItemId === 'first' && node.id !== running.id && node.sourceRef.revision === 2)).toBe(true);
	});
	it('advances the same rejected pair once and blocks further revisions at the accepted review bound', () => {
		const current = graphState(graphProjection()), actor = graphNode(current, 'first', 'actor'), reviewer = graphNode(current, 'first', 'reviewer');
		actor.status = 'completed'; reviewer.status = 'failed'; const before = structuredClone(current);
		const revised = recoverIncompleteReviewCycles(current, new Map([[reviewer.id, 1]]), new Set([reviewer.id]), 2);
		expect(graphNode(revised, 'first', 'actor')).toMatchObject({ id: actor.id, status: 'ready', nodeRevision: 2 });
		expect(graphNode(revised, 'first', 'reviewer')).toMatchObject({ id: reviewer.id, status: 'blocked', nodeRevision: 2 });
		expect(graphNode(revised, 'next', 'actor').status).toBe('blocked');
		const exhausted = structuredClone(before); recoverIncompleteReviewCycles(exhausted, new Map([[reviewer.id, 2]]), new Set([reviewer.id]), 2);
		expect(exhausted).toEqual(before); expect(before.nodes.map(node => node.id)).toEqual(revised.nodes.map(node => node.id));
	});
	it('keeps one team graph and exact project identities deterministic under source permutation', () => {
		const sources = [graphSource(), graphSource('second')], before = structuredClone(sources);
		const first = graphProjection(sources), second = graphProjection([...sources].reverse());
		expect(second).toEqual(first); expect(sources).toEqual(before);
		expect(new Set(first.nodes.map(node => node.id)).size).toBe(first.nodes.length);
		expect(first.edges.every(edge => first.nodes.find(node => node.id === edge.fromNodeId)?.projectId === first.nodes.find(node => node.id === edge.toNodeId)?.projectId)).toBe(true);
	});
	it('requires exact cross-project relation endpoints and rejects moved commit digest revision path and anchor', () => {
		const sources = [graphSource(), graphSource('second')], profiles = graphProfiles(['project', 'second']);
		const endpoint = (source: ReturnType<typeof graphSource>, anchor: string) => ({ store: 'treedx' as const, model: 'proposal', id: String(source.frontmatter.id),
			repository: source.repository, path: source.path, commit: source.commit, digest: source.digest, revision: source.proposalRevision, anchor });
		const link = { from: endpoint(sources[0]!, 'work-item/first'), to: endpoint(sources[1]!, 'work-item/first'),
			sourceRef: { store: 'treedx' as const, model: 'note', id: 'dependency', repository: 'second-library', commit: 'f'.repeat(40), path: 'notes/dependency.mdx' } };
		const projected = projectTeamExecutionGraph({ teamId: 'team', revision: 1, sources, profiles, dependencyLinks: [link] });
		expect(projected.edges.filter(edge => edge.provenance === 'treedx-link')).toHaveLength(1);
		for (const change of [{ commit: 'd'.repeat(40) }, { digest: `sha256:${'d'.repeat(64)}` }, { revision: 2 }, { path: 'proposals/foreign.mdx' }, { anchor: 'work-item/missing' }]) {
			const moved = { ...link, from: { ...link.from, ...change } };
			expect(() => projectTeamExecutionGraph({ teamId: 'team', revision: 1, sources, profiles, dependencyLinks: [moved] })).toThrow();
		}
	});
});
