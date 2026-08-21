import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createKnowledgePublicationStorage } from '../../src/api/knowledge/publication-storage.ts';
import { createLocalPrivateObjectStorage } from '../../src/api/storage/private-object-storage.ts';
import { createControlPlanePostgresDatabase } from '../../src/api/support/control-plane-postgres.ts';

type RunValue = { value?: Record<string, unknown>; device?: string };
type ExpectedKnowledge = { device: string; bookId: string; pageId: string; collectionName: string };

const phase = process.argv[2] ?? 'publication';
assert.equal(process.env.TREESEED_ACCEPTANCE_ENVIRONMENT, 'local', 'Knowledge guarantee verification is local-only.');
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
process.env.TREESEED_PUBLISHED_KNOWLEDGE_ROOT ||= resolve(packageRoot, '.treeseed/runtime/published-knowledge');
process.env.TREESEED_PRIVATE_OBJECT_ROOT ||= resolve(packageRoot, '.treeseed/runtime/private-objects');
const runState = JSON.parse(process.env.TREESEED_GUARANTEE_RUN_STATE ?? '{}') as Record<string, RunValue>;
const sceneDeviceToken = (device: string) => device.replace(/_(chromium|firefox|webkit)$/u, '');
const expected = Object.entries(runState).filter(([key]) => key.startsWith('knowledge.published@')).map(([key, entry]) => {
	const device = entry.device ?? key.split('@').at(-1) ?? 'unknown';
	const bookId = String(entry.value?.bookId ?? '');
	const pageId = String(entry.value?.pageId ?? '');
	assert.ok(bookId && pageId, `Knowledge run state for ${device} is incomplete.`);
	const deviceToken = sceneDeviceToken(device);
	const short = bookId.replace(/^guarantee-book-/u, '').replace(new RegExp(`-${deviceToken}$`, 'u'), '');
	return { device, bookId, pageId, collectionName: `Guarantee Collection ${short} ${deviceToken}` };
});
assert.ok(expected.length, 'Run state contains no UI-created knowledge identifiers.');

const databaseUrl = process.env.TREESEED_DATABASE_URL
	?? 'postgresql://treeseed:treeseed-local-dev@127.0.0.1:54329/treeseed_api';
const database = createControlPlanePostgresDatabase(databaseUrl);
const publications = createKnowledgePublicationStorage({ environment: 'local' });
const privateObjects = createLocalPrivateObjectStorage();
const verified: Array<Record<string, unknown>> = [];
const parse = <T>(value: unknown, fallback: T): T => {
	try { return typeof value === 'string' ? JSON.parse(value) as T : (value as T) ?? fallback; }
	catch { return fallback; }
};

async function audit(eventType: string, targetId: string, published = false) {
	const rows = await database.prepare(`SELECT * FROM audit_events WHERE event_type = ? AND target_id = ? ORDER BY created_at DESC`).bind(eventType, targetId).all();
	return rows.results.find((row) => !published || Boolean(parse<Record<string, unknown>>(row.data_json, {}).publicationId));
}

async function publicationAudit(kind: 'book' | 'page', targetId: string) {
	return await audit(`knowledge.${kind}.created`, targetId, true) ?? await audit(`knowledge.${kind}.updated`, targetId, true);
}

async function publicationEvidence(item: ExpectedKnowledge) {
	const bookAudit = await publicationAudit('book', item.bookId);
	const pageAudit = await publicationAudit('page', item.pageId);
	assert.ok(bookAudit && pageAudit, 'Published book/page audit correlation is missing.');
	const bookData = parse<Record<string, string>>(bookAudit.data_json, {});
	const pageData = parse<Record<string, string>>(pageAudit.data_json, {});
	assert.equal(pageData.workspaceId, bookData.workspaceId);
	assert.equal(pageData.publicationId, bookData.publicationId);
	const publication = await database.prepare('SELECT * FROM knowledge_publications WHERE id = ? LIMIT 1').bind(bookData.publicationId).first();
	assert.equal(publication?.status, 'completed', 'The exact UI publication did not complete.');
	assert.equal(publication?.workspace_id, bookData.workspaceId);
	const review = await database.prepare('SELECT * FROM knowledge_reviews WHERE id = ? LIMIT 1').bind(publication?.review_id).first();
	assert.equal(review?.status, 'approved');
	assert.notEqual(review?.submitted_by_user_id, review?.decided_by_user_id, 'The author approved their own knowledge.');
	assert.equal(review?.commit_sha, publication?.commit_sha);
	const reviewHistory = await database.prepare('SELECT * FROM knowledge_reviews WHERE workspace_id = ? ORDER BY created_at ASC')
		.bind(bookData.workspaceId).all();
	const returned = reviewHistory.results.find((candidate) => candidate.status === 'changes-requested');
	assert.ok(returned?.id, 'The exact workspace was not returned for revision before approval.');
	assert.ok(await audit('knowledge.review.changes_requested', String(returned!.id)), 'The correlated change-request audit is missing.');
	const comments = await database.prepare('SELECT * FROM knowledge_review_comments WHERE review_id = ?').bind(returned!.id).all();
	assert.ok(comments.results.some((comment) => comment.status === 'resolved'), 'The requested review comment was not resolved.');
	const workspace = await database.prepare('SELECT * FROM knowledge_authoring_workspaces WHERE id = ? LIMIT 1').bind(bookData.workspaceId).first();
	assert.ok(workspace?.treedx_workspace_id, 'The correlated TreeDX workspace is missing.');
	assert.equal(workspace?.status, 'published');
	const manifest = await publications.readRevision(String(workspace.team_id), String(publication?.published_revision));
	assert.ok(manifest, 'The immutable publication manifest is missing.');
	const bookEntry = manifest.entries.find((entry) => entry.kind === 'book' && entry.id === item.bookId);
	const pageEntry = manifest.entries.find((entry) => entry.kind === 'page' && entry.id === item.pageId);
	assert.ok(bookEntry && pageEntry, 'The exact run book and page are absent from their publication revision.');
	assert.equal(pageEntry.bookId, item.bookId);
	const pageObject = await publications.readObject(pageEntry.content.objectKey);
	assert.ok(pageObject, 'The immutable page publication object is missing.');
	const pagePayload = JSON.parse(pageObject!);
	assert.ok(pagePayload.definition.relatedNoteIds.includes('note:knowledge-authoring-traceability'),
		'The UI-selected note relationship is absent from the exact published page.');
	assert.ok(pagePayload.definition.relatedQuestionIds.includes('question:trustworthy-knowledge-publication'),
		'The UI-selected question relationship is absent from the exact published page.');
	const project = manifest.projects.find((candidate) => candidate.projectId === workspace.project_id);
	assert.equal(project?.commitSha, publication?.commit_sha, 'TreeDX graph/source commit parity failed.');
	assert.ok(project?.graphRevision, 'The publication has no TreeDX graph revision.');
	const operation = await database.prepare(`SELECT * FROM platform_operations WHERE namespace = 'knowledge' AND operation = 'publish_review' AND input_json::jsonb->>'publicationId' = ? LIMIT 1`).bind(publication?.id).first();
	assert.equal(operation?.status, 'succeeded', 'The exact publication operation did not succeed.');
	return { workspace, review, publication, manifest };
}

async function lifecycleEvidence(item: ExpectedKnowledge) {
	const initial = await publicationEvidence(item);
	const transitions = [
		['knowledge.page.archived', item.pageId], ['knowledge.book.archived', item.bookId],
		['knowledge.book.restored', item.bookId], ['knowledge.page.restored', item.pageId],
	] as const;
	const publicationIds = new Set<string>();
	for (const [eventType, targetId] of transitions) {
		const event = await audit(eventType, targetId);
		assert.ok(event, `The correlated ${eventType} audit is missing.`);
		const data = parse<Record<string, string>>(event!.data_json, {});
		assert.ok(data.publicationId && data.workspaceId && data.publishedRevision,
			`The ${eventType} audit lacks publication correlation.`);
		publicationIds.add(data.publicationId);
		const publication = await database.prepare('SELECT * FROM knowledge_publications WHERE id = ? LIMIT 1')
			.bind(data.publicationId).first();
		assert.equal(publication?.status, 'completed');
		const review = await database.prepare('SELECT * FROM knowledge_reviews WHERE id = ? LIMIT 1')
			.bind(publication?.review_id).first();
		assert.equal(review?.status, 'approved');
		assert.notEqual(review?.submitted_by_user_id, review?.decided_by_user_id);
	}
	assert.equal(publicationIds.size, transitions.length, 'Each lifecycle transition must publish independently.');
	const current = await publications.readCurrent(String(initial.workspace.team_id));
	assert.equal(current?.entries.find((entry) => entry.kind === 'book' && entry.id === item.bookId)?.status, 'published');
	assert.equal(current?.entries.find((entry) => entry.kind === 'page' && entry.id === item.pageId)?.status, 'published');
	return initial;
}

async function completedPacks(item: ExpectedKnowledge) {
	const rows = await database.prepare('SELECT * FROM knowledge_pack_builds ORDER BY created_at DESC LIMIT 200').all();
	return rows.results.filter((row) => row.status === 'completed'
		&& parse<string[]>(row.book_ids_json, []).includes(item.bookId));
}

async function verifyPack(item: ExpectedKnowledge, selected: boolean) {
	const evidence = await publicationEvidence(item);
	const collections = await database.prepare('SELECT * FROM book_collections WHERE name = ? ORDER BY created_at DESC').bind(item.collectionName).all();
	const packs = await completedPacks(item);
	let collection = selected ? collections.results[0] : null;
	const selectedBooks = new Set([item.bookId, 'treeseed-accounts-and-identity']);
	if (selected && collection) assert.deepEqual(new Set(parse<string[]>(collection.book_ids_json, [])), selectedBooks);
	const build = packs.find((row) => selected ? (collection ? row.collection_id === collection.id
		: Boolean(row.collection_id) && parse<string[]>(row.book_ids_json, []).length === selectedBooks.size
			&& parse<string[]>(row.book_ids_json, []).every((id) => selectedBooks.has(id)))
		: !row.collection_id && parse<string[]>(row.book_ids_json, []).length === 1);
	assert.ok(build?.id, `The ${selected ? 'selected-book' : 'single-book'} pack did not complete.`);
	if (selected && !collection) {
		assert.ok(build?.collection_id, 'The selected-book pack lost its saved-collection correlation.');
		assert.ok(await audit('knowledge.collection.created', String(build!.collection_id)), 'The UI-created collection audit is missing.');
		assert.ok(await audit('knowledge.collection.deleted', String(build!.collection_id)), 'The resolved collection blocker audit is missing.');
		collection = { id: build!.collection_id };
	}
	const artifact = parse<any>(build.artifact_json, {});
	const stored = await privateObjects.get(String(artifact.storageKey ?? ''));
	assert.ok(stored?.bytes.length, 'Knowledge-pack artifact bytes are missing.');
	assert.equal(createHash('sha256').update(stored!.bytes).digest('hex'), artifact.digest);
	assert.deepEqual(new Set(artifact.manifest?.members?.map((member: any) => member.bookId)),
		new Set(selected ? [item.bookId, 'treeseed-accounts-and-identity'] : [item.bookId]));
	assert.ok(artifact.manifest?.members?.some((member: any) => member.pageIds?.includes(item.pageId)));
	assert.equal(artifact.manifest?.publicationRevision, build.publication_revision);
	assert.ok(await publications.readRevision(String(evidence.workspace.team_id), String(build.publication_revision)));
	assert.ok(await audit('knowledge.pack.created', String(build.id)), 'The correlated pack audit is missing.');
	return { ...evidence, build, collection };
}

try {
	for (const item of expected) {
		const evidence = phase === 'publication' ? await publicationEvidence(item)
			: phase === 'pack' ? await verifyPack(item, false)
				: phase === 'collection' ? await verifyPack(item, true)
					: phase === 'lifecycle' ? await lifecycleEvidence(item)
					: (() => { throw new Error(`Unsupported knowledge verifier phase: ${phase}`); })();
		verified.push({ device: item.device, bookId: item.bookId, pageId: item.pageId,
			workspaceId: evidence.workspace.id, reviewId: evidence.review.id,
			publicationId: evidence.publication.id, publishedRevision: evidence.manifest.revision,
			buildId: 'build' in evidence ? evidence.build.id : undefined });
	}
} finally {
	await database.close();
}

process.stdout.write(`${JSON.stringify({ ok: true, phase, verified }, null, 2)}\n`);
