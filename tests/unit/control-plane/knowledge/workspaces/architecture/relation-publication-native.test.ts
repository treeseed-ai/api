import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { relationPublicationDatabase } from './relation-publication-fixture.ts';
import { object } from './relation-authoring-fixture.ts';
import { relationPath } from '../../../capacity/execution/graph/architecture/relations/relation-fixture.ts';
import { emptyLivingGraph, graphState, graphNode } from '../../../capacity/execution/graph/architecture/living/living-graph-fixture.ts';
import { createExecutionGraphService, persistExecutionGraph } from '../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';

// Actual submit -> original operation SQL -> DirectControlPlaneRunnerClient ->
// runPlatformOperationOnce -> original executor -> native TreeDX + local immutable
// manifest -> original graph intake/SQL/public explain. NOT provider dispatch,
// authenticated API HTTP, independent Actor review, fixed portfolio, or charges.
describe('native governed dependency Note publication and graph intake', () => {
	it('denies empty missing foreign and stale submission authority without native commit or queued publication', async () => {
		const f = await relationPublicationDatabase(); try {
			const workspace = await f.create(), before = await f.snapshot();
			await expect(f.submit(workspace)).rejects.toMatchObject({ code: 'empty_knowledge_draft' });
			await expect(f.service.submit(undefined, workspace.id, { version: workspace.version })).rejects.toMatchObject({ code: 'authentication_required' });
			await expect(f.service.submit({ id: 'foreign', roles: ['admin'] }, workspace.id, { version: workspace.version })).rejects.toMatchObject({ code: 'knowledge_workspace_author_required' });
			await expect(f.submit({ ...workspace, version: workspace.version - 1 })).rejects.toMatchObject({ code: 'stale_workspace' });
			expect(await f.snapshot()).toEqual(before);
			expect((await f.service.diff(f.principal, workspace.id)).changedPaths).toEqual([]);
			expect(await f.store.all("SELECT * FROM platform_operations WHERE namespace='knowledge'")).toEqual([]);
		} finally { await f.close(); }
	}, 60_000);
	it('concurrent native submissions retain one original admitted change exact commit and queued publication without duplicate operation or proposal rewrite', async () => {
		const f = await relationPublicationDatabase(); try {
			const originals = structuredClone(f.sources), workspace = await f.create(), written = await f.write(workspace);
			const outcomes = await Promise.allSettled([f.submit(written.workspace), f.submit(written.workspace)]);
			expect(outcomes.some(outcome => outcome.status === 'fulfilled')).toBe(true);
			const after = await f.snapshot(); expect(after.reviews).toHaveLength(1); expect(after.publications).toHaveLength(1);
			expect(after.reviews[0]).toMatchObject({ status: 'approved', requires_editorial_review: 0 });
			expect(after.publications[0]).toMatchObject({ status: 'queued', commit_sha: after.reviews[0]!.commit_sha });
			expect(await f.store.all("SELECT * FROM platform_operations WHERE namespace='knowledge' AND operation='publish_review'")).toHaveLength(1);
			expect(after.ledger).toEqual([]); expect(f.sources).toEqual(originals);
		} finally { await f.close(); }
	}, 60_000);
	it('ordinary submission and actual runner publish the native exact Note then owning graph persistence exposes the independent reviewer dependency gate', async () => {
		const f = await relationPublicationDatabase(); try {
			const originals = structuredClone(f.sources), workspace = await f.create(), written = await f.write(workspace), submitted = await f.submit(written.workspace);
			const operation = submitted.integration.operation, result = await f.run(operation.id);
			expect(result).toMatchObject({ ok: true, claimed: true, operation: { status: 'succeeded' }, output: { commitSha: submitted.commit.commitSha, publishedRef: 'refs/heads/staging' } });
			const manifest = await f.storage.readCurrent('team'); expect(manifest).toBeTruthy();
			expect(manifest!.projects).toContainEqual(expect.objectContaining({ projectId: 'precursor', repositoryId: workspace.repositoryId, commitSha: submitted.commit.commitSha, ref: 'refs/heads/staging' }));
			const links = await f.load(); expect(links).toHaveLength(1);
			expect(links[0]).toEqual({ from: f.link.from, to: f.link.to, sourceRef: { store: 'treedx', model: 'note', id: f.note.id,
				repository: workspace.repositoryId, commit: submitted.commit.commitSha, path: relationPath,
				digest: `sha256:${createHash('sha256').update(f.content).digest('hex')}` } });
			const projection = f.project(links), graph = graphState(projection);
			await persistExecutionGraph(f.store, graph, emptyLivingGraph(), { ...projection.revision, graphDigest: graph.digest });
			const service = createExecutionGraphService(f.store); expect(await service.show(f.principal, 'team', {})).toEqual(graph);
			const explained = await service.explain(f.principal, 'team', graphNode(graph, 'first', 'actor', 'dependent').id);
			expect(explained.admission.eligible).toBe(false);
			expect(explained.predecessors).toContainEqual(expect.objectContaining({ edge: expect.objectContaining({ provenance: 'treedx-link', sourceRef: links[0]!.sourceRef }), satisfied: false }));
			expect(f.sources).toEqual(originals); expect((await f.snapshot()).ledger).toEqual([]);
			const before = await f.snapshot(); expect(await f.run(operation.id)).toMatchObject({ ok: true, claimed: false });
			expect(await f.storage.readCurrent('team')).toEqual(manifest); expect(await f.snapshot()).toEqual(before);
		} finally { await f.close(); }
	}, 60_000);
	it('actual native staging movement after submission denies compare and swap publication without false manifest success or changed original candidate', async () => {
		const f = await relationPublicationDatabase(); try {
			const workspace = await f.create(), written = await f.write(workspace), submitted = await f.submit(written.workspace);
			const competing = object(await f.client.workspaces.create(workspace.repositoryId, { baseRef: workspace.baseCommitSha,
				branchName: 'refs/heads/staging', mode: 'writable', allowedPaths: ['README.md'] }));
			const id = String(competing.workspaceId); try {
				await f.client.files.write(id, { path: 'README.md', content: 'Independent native staging movement\n' });
				await f.client.files.commit(id, { message: 'Move disposable staging', author: { name: 'Fixture', email: 'fixture@example.invalid' } });
			} finally { await f.client.workspaces.close(id); }
			const result = await f.run(submitted.integration.operation.id); expect(result.ok).toBe(false);
			expect(result.operation.status).toBe('failed'); expect(await f.storage.readCurrent('team')).toBeNull();
			const after = await f.snapshot(); expect(after.publications[0]).toMatchObject({ status: 'queued', commit_sha: submitted.commit.commitSha });
			expect(after.audits.filter(row => row.event_type === 'knowledge.publication.completed')).toEqual([]); expect(after.ledger).toEqual([]);
		} finally { await f.close(); }
	}, 60_000);
	it('late original publication audit interruption preserves native published commit immutable manifest and failed runner history before exact recovery replay', async () => {
		const f = await relationPublicationDatabase(); try {
			const workspace = await f.create(), written = await f.write(workspace), submitted = await f.submit(written.workspace), operationId = submitted.integration.operation.id;
			await f.db.exec(`CREATE FUNCTION reject_publication_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
				IF NEW.event_type='knowledge.publication.completed' THEN RAISE EXCEPTION 'controlled late publication audit interruption'; END IF; RETURN NEW; END $$;
				CREATE TRIGGER reject_publication_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_publication_audit();`);
			const failed = await f.run(operationId); expect(failed.ok).toBe(false); expect(failed.operation.status).toBe('failed');
			expect(failed.error?.message).toContain('controlled late publication audit interruption');
			const manifest = await f.storage.readCurrent('team'); expect(manifest).toBeTruthy();
			const after = await f.snapshot(); expect(after.publications[0]).toMatchObject({ status: 'completed', commit_sha: submitted.commit.commitSha });
			expect(after.audits.filter(row => row.event_type === 'knowledge.publication.completed')).toEqual([]);
			const failedEvents = await f.store.listPlatformOperationEvents(operationId);
			expect(failedEvents).toContainEqual(expect.objectContaining({ kind: 'runner.retry_safe_failure' }));
			await f.db.exec('DROP TRIGGER reject_publication_audit ON audit_events; DROP FUNCTION reject_publication_audit();');
			const original = await f.store.findPlatformOperationById(operationId); await f.store.retryPlatformOperation(operationId);
			expect((await f.store.findPlatformOperationById(operationId)).input).toEqual(original.input);
			expect(await f.run(operationId)).toMatchObject({ ok: true, operation: { status: 'succeeded' } });
			expect(await f.storage.readCurrent('team')).toEqual(manifest);
			const recovered = await f.snapshot(); expect(recovered.publications).toEqual(after.publications); expect(recovered.reviews).toEqual(after.reviews); expect(recovered.ledger).toEqual(after.ledger);
			expect(recovered.audits.filter(row => row.event_type === 'knowledge.publication.completed')).toHaveLength(1);
			const events = await f.store.listPlatformOperationEvents(operationId); for (const event of failedEvents) expect(events).toContainEqual(event);
			expect(await f.run(operationId)).toMatchObject({ claimed: false });
		} finally { await f.close(); }
	}, 60_000);
});
