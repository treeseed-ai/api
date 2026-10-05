import { describe, expect, it } from 'vitest';
import { applyOperationalState, type TeamGraph } from '../../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-state.ts';
import { graphNode, emptyLivingGraph } from '../living/living-graph-fixture.ts';
import { relationInputs } from './relation-fixture.ts';

const state = (p: ReturnType<ReturnType<typeof relationInputs>['project']>): TeamGraph => ({ teamId: 'team',
	revision: p.revision.revision, digest: p.revision.graphDigest, nodes: p.nodes, edges: p.edges });

describe('exact cross-project dependency authority', () => {
	it('binds the sole cross-project edge to the exact note and approved reviewer without merging project authority or limits', () => {
		const f = relationInputs(), before = structuredClone({ sources: f.sources, dependency: f.dependency, profiles: f.profiles });
		const p = f.project(), graph = applyOperationalState(emptyLivingGraph(), state(p), 1);
		const from = graphNode(graph, 'first', 'reviewer', 'precursor'), to = graphNode(graph, 'first', 'actor', 'dependent');
		expect(p.edges.filter(edge => edge.provenance === 'treedx-link')).toEqual([expect.objectContaining({ fromNodeId: from.id, toNodeId: to.id, sourceRef: f.dependency.sourceRef })]);
		expect(to.status).toBe('blocked'); expect(to.sourceRef).toMatchObject({ repository: 'dependent-library', commit: f.sources[1]!.commit });
		expect(to.estimate).toEqual(graphNode(graph, 'first', 'actor', 'precursor').estimate);
		expect({ sources: f.sources, dependency: f.dependency, profiles: f.profiles }).toEqual(before);
	});
	it('rejects every endpoint identity revision digest commit path anchor model and store drift instead of silently dropping the dependency', () => {
		for (const side of ['from', 'to'] as const) for (const [field, value] of Object.entries({ id: 'foreign', revision: 2,
			digest: `sha256:${'f'.repeat(64)}`, commit: 'f'.repeat(40), path: 'proposals/foreign.md', anchor: 'work-item/missing', model: 'note', store: 'git', repository: 'foreign-library' })) {
			const f = relationInputs(), before = structuredClone(f.sources), changed = { ...f.dependency, [side]: { ...f.dependency[side], [field]: value } };
			expect(() => f.project([changed]), `${side}.${field}`).toThrow(); expect(f.sources).toEqual(before);
		}
	});
	it('rejects reciprocal cross-project cycles while duplicate identical relation replay produces one stable edge', () => {
		const f = relationInputs(), first = f.project(), replay = f.project([f.dependency, structuredClone(f.dependency)]);
		expect(replay).toEqual(first);
		expect(() => f.project([f.dependency, { ...f.dependency, from: f.dependency.to, to: f.dependency.from }])).toThrow();
	});
	it('keeps dependent work blocked through failed cancelled or unapproved precursor candidates and releases only the successful independent review', () => {
		const f = relationInputs(), projection = state(f.project()), initial = applyOperationalState(emptyLivingGraph(), projection, 1);
		for (const status of ['running', 'failed', 'cancelled', 'completed'] as const) {
			const prior = structuredClone(initial); graphNode(prior, 'first', 'actor', 'precursor').status = status;
			const next = applyOperationalState(prior, projection, 2, new Set([graphNode(prior, 'first', 'actor', 'precursor').id]));
			expect(graphNode(next, 'first', 'actor', 'dependent').status, status).toBe('blocked');
		}
		const approved = structuredClone(initial); graphNode(approved, 'first', 'actor', 'precursor').status = 'completed';
		graphNode(approved, 'first', 'reviewer', 'precursor').status = 'completed';
		const review = graphNode(approved, 'first', 'reviewer', 'precursor');
		const next = applyOperationalState(approved, projection, 2, new Set(), new Map([[review.id, { status: 'completed', nodeRevision: review.nodeRevision }]]));
		expect(graphNode(next, 'first', 'actor', 'dependent').status).toBe('ready');
		expect(graphNode(initial, 'first', 'actor', 'dependent').status).toBe('blocked');
	});
});
