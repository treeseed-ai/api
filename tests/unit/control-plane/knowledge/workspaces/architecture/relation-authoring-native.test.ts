import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { object, relationAuthoringDatabase } from './relation-authoring-fixture.ts';
import { relationPath } from '../../../capacity/execution/graph/architecture/relations/relation-fixture.ts';

// Real native TreeDX workspace/Git/graph/search plus original API store SQL and
// owning knowledge service. No controlled HTTP substitute, no missing-env pass.
// This is not a managed provider run, authenticated operator HTTP or whole
// publication-runner/portfolio acceptance. All resources created inside tests.
describe('native ordinary relation creation and indexing', () => {
	it('real TreeDX authoring denies malformed Note identities and duplicate subject authority across unchanged retries before exact original publication bytes', async () => {
		const f = await relationAuthoringDatabase(); try {
			const workspace = await f.create(), before = await f.snapshot(), original = structuredClone(f.note);
			const missing = { ...f.note }; delete missing.id;
			const invalid = [missing, ...['', ' padded', 'internal space', 'é', 'a'.repeat(201), null].flatMap(value =>
				[{ ...f.note, id: value }, { ...f.note, projectId: value }]),
				{ ...f.note, subjectRefs: [f.link.from, f.link.from] },
				{ ...f.note, subjectRefs: [f.link.from, Object.fromEntries(Object.entries(f.link.from).reverse())] }];
			const inputs = invalid.map(note => `---\n${stringify(note)}---\n\nReviewed precursor governs dependent work.\n`), held = [...inputs];
			for (const input of inputs) for (let retry = 0; retry < 2; retry++) {
				await expect(f.write(workspace, input)).rejects.toMatchObject({ status: 422, code: 'operational_content_invalid' });
				expect(await f.snapshot()).toEqual(before);
				expect((await f.service.diff(f.principal, workspace.id)).changedPaths).toEqual([]);
			}
			const written = await f.write(workspace);
			expect(written.workspace.version).toBe(workspace.version + 1);
			expect((await f.service.readContent(f.principal, workspace.id, relationPath)).content).toBe(f.content);
			expect((await f.service.diff(f.principal, workspace.id)).changedPaths).toEqual([relationPath]);
			const after = await f.snapshot(); expect(after.ledger).toEqual(before.ledger);
			expect(after.reviews).toEqual(before.reviews); expect(after.publications).toEqual(before.publications);
			expect(after.audits.filter(entry => entry.event_type === 'knowledge.operational_content.updated')).toHaveLength(1);
			expect(inputs).toEqual(held); expect(f.note).toEqual(original);
		} finally { await f.close(); }
	}, 60_000);
	it('creates and replays one governed native workspace writes canonical relation bytes and reads original exact draft without changing proposal endpoints', async () => {
		const f = await relationAuthoringDatabase(); try {
			const originals = structuredClone(f.sources), workspace = await f.create();
			const replay = await f.create(workspace.id); expect(replay).toEqual(workspace);
			const written = await f.write(workspace); expect(written.workspace.version).toBe(workspace.version + 1);
			const read = await f.service.readContent(f.principal, workspace.id, relationPath);
			expect(read).toMatchObject({ kind: 'operational-content', model: 'note', path: relationPath, content: f.content });
			expect(typeof read.expectedSha).toBe('string'); expect(read.expectedSha.length).toBeGreaterThan(0);
			expect((await f.service.diff(f.principal, workspace.id)).changedPaths).toEqual([relationPath]);
			expect(f.sources).toEqual(originals);
			expect((await f.snapshot()).reviews).toEqual([]); expect((await f.snapshot()).publications).toEqual([]);
		} finally { await f.close(); }
	}, 60_000);
	it('denies missing malformed empty unsupported relation and unsafe path writes before native draft or original SQL custody changes', async () => {
		const f = await relationAuthoringDatabase(); try {
			const workspace = await f.create(), before = await f.snapshot();
			for (const content of ['', '---\nlinks: []\n---\n', f.content.replace('depends_on', 'invented_dependency')]) {
				await expect(f.write(workspace, content)).rejects.toMatchObject({ code: expect.any(String) });
			}
			for (const path of ['../notes/escape.md', '/notes/absolute.md', 'notes//empty.md', '.git/config', 'foreign/notes/exact.md']) {
				await expect(f.write(workspace, f.content, { sourcePath: path })).rejects.toMatchObject({ code: expect.any(String) });
			}
			expect((await f.service.diff(f.principal, workspace.id)).changedPaths).toEqual([]);
			expect(await f.snapshot()).toEqual(before);
		} finally { await f.close(); }
	}, 60_000);
	it('denies missing foreign and stale author authority and rejects updates after actual native workspace closure without widening the original scope', async () => {
		const f = await relationAuthoringDatabase(); try {
			const workspace = await f.create(), before = await f.snapshot();
			await expect(f.service.updateContent(undefined, workspace.id, {})).rejects.toMatchObject({ code: 'authentication_required' });
			await expect(f.service.updateContent({ id: 'other-operator', roles: ['admin'] }, workspace.id, {})).rejects.toMatchObject({ code: 'knowledge_workspace_author_required' });
			await expect(f.write(workspace, f.content, { version: workspace.version - 1 })).rejects.toMatchObject({ code: 'stale_workspace' });
			expect(await f.snapshot()).toEqual(before);
			await f.client.workspaces.close(workspace.treeDxWorkspaceId);
			await expect(f.write(workspace)).rejects.toBeDefined(); expect(await f.snapshot()).toEqual(before);
		} finally { await f.close(); }
	}, 60_000);
	it('concurrent identical native edits retain one original version transition and exact relation bytes without duplicate successful custody or financial rows', async () => {
		const f = await relationAuthoringDatabase(); try {
			const workspace = await f.create(), before = await f.snapshot();
			const outcomes = await Promise.allSettled([f.write(workspace), f.write(workspace)]);
			expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
			expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
			expect((await f.service.show(f.principal, workspace.id)).version).toBe(workspace.version + 1);
			expect((await f.service.readContent(f.principal, workspace.id, relationPath)).content).toBe(f.content);
			const after = await f.snapshot(); expect(after.ledger).toEqual(before.ledger);
			expect(after.audits.filter(entry => entry.event_type === 'knowledge.operational_content.updated')).toHaveLength(1);
		} finally { await f.close(); }
	}, 60_000);
	it('native exact relation commit graph and search refresh feed the owning dependency loader with raw byte provenance and unchanged proposal endpoints', async () => {
		const f = await relationAuthoringDatabase(); try {
			const originals = structuredClone(f.sources), workspace = await f.create(); await f.write(workspace);
			const result = await f.commitAndLoad(workspace);
			expect(result.loaded).toHaveLength(1);
			expect(result.loaded[0]).toMatchObject({ from: f.link.from, to: f.link.to, sourceRef: {
				store: 'treedx', model: 'note', id: f.note.id, repository: f.sources[0]!.repository, commit: result.commit, path: relationPath,
				digest: `sha256:${createHash('sha256').update(f.content).digest('hex')}` } });
			expect(f.sources).toEqual(originals);
			for (let repeat = 0; repeat < 2; repeat++) {
				const read = object(await result.read.client.readRepositoryFile({ repoId: f.sources[0]!.repository, ref: result.commit, path: relationPath }));
				expect(read).toEqual(result.file);
			}
		} finally { await f.close(); }
	}, 60_000);
	it('late actual audit insertion failure retains native written bytes and recoverable original draft without false publication finance or successful replay', async () => {
		const f = await relationAuthoringDatabase(); try {
			const workspace = await f.create(), before = await f.snapshot();
			await f.db.exec(`CREATE FUNCTION reject_relation_audit() RETURNS trigger AS $$ BEGIN
				IF NEW.event_type='knowledge.operational_content.updated' THEN RAISE EXCEPTION 'controlled late relation audit interruption'; END IF;
				RETURN NEW; END; $$ LANGUAGE plpgsql;
				CREATE TRIGGER reject_relation_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_relation_audit();`);
			await expect(f.write(workspace)).rejects.toThrow('controlled late relation audit interruption');
			expect((await f.service.readContent(f.principal, workspace.id, relationPath)).content).toBe(f.content);
			const interrupted = await f.snapshot(); expect(interrupted.ledger).toEqual(before.ledger);
			expect(interrupted.publications).toEqual([]); expect(interrupted.reviews).toEqual([]);
			expect(interrupted.audits.filter(entry => entry.event_type === 'knowledge.operational_content.updated')).toEqual([]);
			await expect(f.write(workspace)).rejects.toMatchObject({ code: 'stale_workspace' });
			await f.db.exec('DROP TRIGGER reject_relation_audit ON audit_events; DROP FUNCTION reject_relation_audit();');
			const current = await f.service.show(f.principal, workspace.id);
			const bytes = await f.service.readContent(f.principal, workspace.id, relationPath);
			await f.write(current, f.content, { create: false, expectedSha: bytes.expectedSha });
			expect((await f.service.readContent(f.principal, workspace.id, relationPath)).content).toBe(f.content);
			expect((await f.snapshot()).audits.filter(entry => entry.event_type === 'knowledge.operational_content.updated')).toHaveLength(1);
		} finally { await f.close(); }
	}, 60_000);
});
