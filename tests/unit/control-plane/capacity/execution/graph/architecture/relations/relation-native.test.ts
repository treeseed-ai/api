import { describe, expect, it } from 'vitest';
import { graphNode, graphState } from '../living/living-graph-fixture.ts';
import { relationDatabase, relationCommit, relationPath } from './relation-fixture.ts';

describe('exact dependency intake native HTTP original SQL and public graph reads', () => {
	it('preserves admitted dotted and slashed work-item identifiers through signed exact intake SQL custody and independent reviewer admission', async () => {
		const f = await relationDatabase(); try {
			const ids = ['deployment-tester/simulation-upstream-acceptance', 'sdk.remote-git-ref-operation-contract'];
			for (const [index, source] of f.sources.entries()) {
				const plan = source.frontmatter.executionPlan;
				if (!plan || typeof plan !== 'object' || !('workItems' in plan) || !Array.isArray(plan.workItems)) throw new Error('Controlled work-item inventory required.');
				const items: unknown[] = plan.workItems, first = items[0], next = items[1];
				if (!first || typeof first !== 'object' || !('id' in first) || !next || typeof next !== 'object' || !('dependsOn' in next)) throw new Error('Controlled original work-item pair required.');
				first.id = ids[index]!; next.dependsOn = [ids[index]!];
			}
			const link = { ...f.link, from: { ...f.link.from, anchor: `work-item/${ids[0]}` },
				to: { ...f.link.to, anchor: `work-item/${ids[1]}` } };
			const setLink = (value: typeof link) => {
				f.setGraph({ ...f.graph, nodes: [{ node: { ...f.graph.nodes[0]!.node, data: value.from } },
					{ node: { ...f.graph.nodes[1]!.node, data: value.to } }],
					edges: [{ ...f.graph.edges[0]!, data: { link: value, ownerPath: relationPath } }] });
				f.setNote({ resolvedRef: relationCommit, files: [{ path: relationPath, content: f.content,
					frontmatter: { ...f.note, subjectRefs: [value.from, value.to], links: [value] } }] });
			};
			const sources = structuredClone(f.sources), before = await f.snapshot();
			for (const anchor of ['work-item/a..b', 'work-item/a//b', 'work-item/a/../b', 'work-item/sdk%2Eitem']) {
				setLink({ ...link, from: { ...link.from, anchor } });
				await expect(f.load()).rejects.toThrow(); expect(await f.snapshot()).toEqual(before);
			}
			setLink(link);
			const links = await f.load(); expect(links).toEqual([{ from: link.from, to: link.to, sourceRef: f.dependency.sourceRef }]);
			expect(await f.snapshot()).toEqual(before); expect(f.sources).toEqual(sources);
			const p = f.project(links), graph = graphState(p); await f.persist(graph, f.empty(), p.revision);
			expect(await f.service.show(f.principal, 'team', {})).toEqual(graph);
			const actor = graphNode(graph, ids[1]!, 'actor', 'dependent'), reviewer = graphNode(graph, ids[0]!, 'reviewer', 'precursor');
			const explanation = await f.service.explain(f.principal, 'team', actor.id);
			expect(explanation.admission.eligible).toBe(false);
			expect(explanation.predecessors).toContainEqual(expect.objectContaining({ edge: expect.objectContaining({
				fromNodeId: reviewer.id, toNodeId: actor.id, provenance: 'treedx-link', sourceRef: f.dependency.sourceRef }), satisfied: false }));
			expect(f.sources).toEqual(sources);
		} finally { await f.close(); }
	});
	it('loads signed exact relation authority and persists separate project nodes with the independent reviewer gate and note provenance', async () => {
		const f = await relationDatabase(); try {
			const before = structuredClone(f.sources), links = await f.load(); expect(links).toEqual([f.dependency]);
			const p = f.project(links), graph = graphState(p); await f.persist(graph, f.empty(), p.revision);
			expect(await f.service.show(f.principal, 'team', {})).toEqual(graph);
			const explanation = await f.service.explain(f.principal, 'team', graphNode(graph, 'first', 'actor', 'dependent').id);
			expect(explanation.admission.eligible).toBe(false);
			expect(explanation.predecessors).toContainEqual(expect.objectContaining({ edge: expect.objectContaining({ provenance: 'treedx-link', sourceRef: f.dependency.sourceRef }), satisfied: false }));
			const noteCalls = f.calls.filter(call => call.route.endsWith('/files/read')); expect(noteCalls).toHaveLength(1);
			expect(noteCalls[0]!.body).toEqual({ ref: relationCommit, path: relationPath, encoding: 'utf8', parseFrontmatter: true, allowProtected: true });
			expect(noteCalls[0]!.scope).toMatchObject({ treedx_repo_ids: ['precursor-library'], treeseed_project_id: 'precursor', treeseed_connection_id: 'isolated-connection' });
			expect(noteCalls[0]!.scope.treedx_refs).toContain(relationCommit);
			expect(noteCalls[0]!.scope.treedx_capabilities).not.toContain('files:write'); expect(f.sources).toEqual(before);
		} finally { await f.close(); }
	});
	it('pins the published library ref before querying its graph when a moving-ref index is stale', async () => {
		const publishedRef = 'refs/remotes/origin/staging', f = await relationDatabase({ publishedRef }); try {
			const links = await f.load(); expect(links).toEqual([f.dependency]);
			const graphCalls = f.calls.filter(call => call.route.endsWith('/graph/query'));
			expect(graphCalls).toHaveLength(2);
			for (const call of graphCalls) { expect(call.body.ref).toMatch(/^[a-f0-9]{40}$/u); expect(call.scope.treedx_refs).toContain(call.body.ref); }
			const pathCalls = f.calls.filter(call => call.route.endsWith('/paths/list')); expect(pathCalls).toHaveLength(2);
			for (const call of pathCalls) { expect(call.body.ref).toBe(publishedRef); expect(call.scope.treedx_refs).toContain(publishedRef); }
			const p = f.project(links), graph = graphState(p); await f.persist(graph, f.empty(), p.revision);
			const explanation = await f.service.explain(f.principal, 'team', graphNode(graph, 'first', 'actor', 'dependent').id);
			expect(explanation.admission.eligible).toBe(false);
			expect(explanation.predecessors).toContainEqual(expect.objectContaining({ edge: expect.objectContaining({ provenance: 'treedx-link' }), satisfied: false }));
		} finally { await f.close(); }
	});
	it('retains the digest of exact untrimmed note bytes and denies mismatched returned note path rather than inventing content custody', async () => {
		const f = await relationDatabase(); try {
			expect((await f.load())[0]!.sourceRef.digest).toBe(f.dependency.sourceRef.digest);
			const before = await f.snapshot(); f.setNote({ resolvedRef: relationCommit, files: [{ path: 'notes/foreign.md', content: f.content, frontmatter: f.note }] });
			await expect(f.load()).rejects.toThrow(); expect(await f.snapshot()).toEqual(before);
		} finally { await f.close(); }
	});
	it('denies unpinned malformed truncated and missing graph authorities before any graph persistence', async () => {
		for (const reply of [{ resolvedRef: 'staging', nodes: [], edges: [] }, { ...relationDatabaseGraph(), nodes: null },
			{ ...relationDatabaseGraph(), nodes: Array.from({ length: 50 }, () => ({})) }, { ...relationDatabaseGraph(), edges: null },
			{ ...relationDatabaseGraph(), edges: [{ type: 'DEPENDS_ON', data: {} }] }]) {
			const f = await relationDatabase(); try { const before = await f.snapshot(); f.setGraph(reply);
				await expect(f.load()).rejects.toThrow(); expect(await f.snapshot()).toEqual(before);
			} finally { await f.close(); }
		}
	});
	it('denies missing foreign and path-excluded endpoint library bindings without reading a note or changing owning graph history', async () => {
		for (const mutation of ['missing', 'repository', 'path'] as const) {
			const f = await relationDatabase(); try {
				if (mutation === 'missing') await f.query('DELETE FROM treedx_project_libraries WHERE project_id=?', ['dependent']);
				else await f.query(`UPDATE treedx_project_libraries SET ${mutation === 'repository' ? 'repository_id' : 'content_path'}=? WHERE project_id=?`, [mutation === 'repository' ? 'foreign-library' : 'restricted', 'dependent']);
				const before = await f.snapshot(); await expect(f.load()).rejects.toThrow();
				expect(f.calls.filter(call => call.route.endsWith('/files/read'))).toEqual([]); expect(await f.snapshot()).toEqual(before);
			} finally { await f.close(); }
		}
	});
	it('denies moved missing foreign project and unlinked exact note replies and rejects stale endpoint digest at the owning projector', async () => {
		for (const mutation of ['moved', 'missing', 'project', 'unlinked', 'digest'] as const) {
			const f = await relationDatabase(); try {
				if (mutation === 'digest') {
					const link = { ...f.link, to: { ...f.link.to, digest: `sha256:${'f'.repeat(64)}` } };
					f.setGraph({ ...f.graph, edges: [{ ...f.graph.edges[0]!, data: { link, ownerPath: relationPath } }] });
					f.setNote({ resolvedRef: relationCommit, files: [{ path: relationPath, content: f.content, frontmatter: { ...f.note, links: [link] } }] });
				} else f.setNote(mutation === 'missing' ? { resolvedRef: relationCommit, files: [] } : { resolvedRef: mutation === 'moved' ? 'e'.repeat(40) : relationCommit,
					files: [{ path: relationPath, content: f.content, frontmatter: { ...f.note, ...(mutation === 'project' ? { projectId: 'foreign' } : {}), ...(mutation === 'unlinked' ? { links: [] } : {}) } }] });
				const before = await f.snapshot(); await expect((async () => f.project(await f.load()))()).rejects.toThrow();
				expect(await f.snapshot()).toEqual(before);
			} finally { await f.close(); }
		}
	});
	it('native graph and note HTTP denial unavailable reset and malformed responses retain original authority and retry without phantom SQL success', async () => {
		for (const boundary of ['paths', 'graph', 'note'] as const) for (const fault of ['403', '503', 'reset', 'json'] as const) {
			const f = await relationDatabase(); try {
				const before = await f.snapshot(), sources = structuredClone(f.sources); f.setFault(fault, boundary);
				await expect(f.load()).rejects.toThrow(); expect(await f.snapshot()).toEqual(before); expect(f.sources).toEqual(sources);
				f.setFault('none'); const links = await f.load(); expect(links).toEqual([f.dependency]);
				expect(await f.snapshot()).toEqual(before); expect(f.sources).toEqual(sources);
			} finally { await f.close(); }
		}
	});
	it('concurrent exact intake replay and late SQL interruption preserve one relation edge with rollback and exact retry readback', async () => {
		const f = await relationDatabase(); try {
			const loaded = await Promise.all([f.load(), f.load()]); expect(loaded[0]).toEqual(loaded[1]);
			const p = f.project(loaded[0]), graph = graphState(p), before = await f.snapshot();
			await f.db.exec("CREATE FUNCTION reject_relation_edge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.provenance='treedx-link' THEN RAISE EXCEPTION 'isolated relation interruption'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_relation_edge BEFORE INSERT ON execution_edges FOR EACH ROW EXECUTE FUNCTION reject_relation_edge();");
			await expect(f.persist(graph, f.empty(), p.revision)).rejects.toThrow('isolated relation interruption'); expect(await f.snapshot()).toEqual(before);
			await f.db.exec('DROP TRIGGER reject_relation_edge ON execution_edges; DROP FUNCTION reject_relation_edge();');
			await f.persist(graph, f.empty(), p.revision); expect(await f.service.show(f.principal, 'team', {})).toEqual(graph);
			expect((await f.snapshot()).edges.filter(row => row.provenance === 'treedx-link')).toHaveLength(1);
			const persisted = await f.snapshot(); await f.load(); expect(await f.snapshot()).toEqual(persisted);
		} finally { await f.close(); }
	});
});

function relationDatabaseGraph() { return { resolvedRef: relationCommit, nodes: [], edges: [] }; }
