import { randomUUID } from 'node:crypto';
import { BOOK_COLLECTION_SCHEMA_VERSION } from '@treeseed/sdk/knowledge';
import { isoNow, parseJson, type MarketControlPlaneStore } from '../../persistence/store.ts';

function collection(row: any) {
	return row ? {
		schemaVersion: BOOK_COLLECTION_SCHEMA_VERSION, id: row.id, teamId: row.team_id, name: row.name, summary: row.summary ?? undefined,
		bookIds: parseJson(row.book_ids_json, []), createdByUserId: row.created_by_user_id,
		managed: row.id === 'treeseed-platform-library',
		version: Number(row.version), createdAt: row.created_at, updatedAt: row.updated_at,
	} : null;
}

function build(row: any) {
	const artifact = parseJson(row?.artifact_json, {});
	return row ? {
		id: row.id, teamId: row.team_id, collectionId: row.collection_id ?? undefined,
		requestedByUserId: row.requested_by_user_id, bookIds: parseJson(row.book_ids_json, []),
		sourceClosure: row.source_closure ?? undefined, publicationRevision: row.publication_revision, status: row.status,
		artifact: Object.keys(artifact).length ? artifact : undefined, error: row.error ?? undefined,
		version: Number(row.version), createdAt: row.created_at, updatedAt: row.updated_at,
		completedAt: row.completed_at ?? undefined,
	} : null;
}

export async function listBookCollectionsMethod(this: MarketControlPlaneStore, teamId: string) {
	await this.ensureInitialized();
	return (await this.all('SELECT * FROM book_collections WHERE team_id = ? ORDER BY name ASC', [teamId])).map(collection);
}

export async function getBookCollectionMethod(this: MarketControlPlaneStore, id: string) {
	await this.ensureInitialized();
	return collection(await this.first('SELECT * FROM book_collections WHERE id = ? LIMIT 1', [id]));
}

export async function createBookCollectionMethod(this: MarketControlPlaneStore, input: any) {
	await this.ensureInitialized();
	const id = input.id ?? randomUUID();
	const now = isoNow();
	await this.run(`INSERT INTO book_collections
		(id, team_id, name, summary, book_ids_json, created_by_user_id, version, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`, [id, input.teamId, input.name, input.summary ?? null,
		JSON.stringify(input.bookIds), input.createdByUserId, now, now]);
	return this.getBookCollection(id);
}

export async function updateBookCollectionMethod(this: MarketControlPlaneStore, id: string, input: any) {
	await this.ensureInitialized();
	const current = await this.getBookCollection(id);
	if (!current) return { ok: false, code: 'missing' };
	if (current.version !== Number(input.version)) return { ok: false, code: 'stale', collection: current };
	const result = await this.run(`UPDATE book_collections SET name = ?, summary = ?, book_ids_json = ?,
		version = version + 1, updated_at = ? WHERE id = ? AND version = ?`, [input.name, input.summary ?? null,
		JSON.stringify(input.bookIds), isoNow(), id, current.version]);
	return Number(result.meta?.changes ?? 0) === 1
		? { ok: true, collection: await this.getBookCollection(id) }
		: { ok: false, code: 'stale', collection: await this.getBookCollection(id) };
}

export async function deleteBookCollectionMethod(this: MarketControlPlaneStore, id: string, version: number) {
	await this.ensureInitialized();
	const result = await this.run('DELETE FROM book_collections WHERE id = ? AND version = ?', [id, version]);
	return { ok: Number(result.meta?.changes ?? 0) === 1 };
}

export async function createKnowledgePackBuildMethod(this: MarketControlPlaneStore, input: any) {
	await this.ensureInitialized();
	const id = input.id ?? randomUUID();
	const now = isoNow();
	await this.run(`INSERT INTO knowledge_pack_builds
		(id, team_id, collection_id, requested_by_user_id, book_ids_json, source_closure, publication_revision, status,
		 artifact_json, error, version, created_at, updated_at, completed_at)
		VALUES (?, ?, ?, ?, ?, NULL, ?, 'queued', '{}', NULL, 1, ?, ?, NULL)`, [id, input.teamId,
		input.collectionId ?? null, input.requestedByUserId, JSON.stringify(input.bookIds), input.publicationRevision, now, now]);
	return this.getKnowledgePackBuild(id);
}

export async function getKnowledgePackBuildMethod(this: MarketControlPlaneStore, id: string) {
	await this.ensureInitialized();
	return build(await this.first('SELECT * FROM knowledge_pack_builds WHERE id = ? LIMIT 1', [id]));
}

export async function listKnowledgePackBuildsMethod(this: MarketControlPlaneStore, teamId: string) {
	await this.ensureInitialized();
	return (await this.all(`SELECT * FROM knowledge_pack_builds WHERE team_id = ?
		ORDER BY created_at DESC LIMIT 100`, [teamId])).map(build);
}

export async function updateKnowledgePackBuildMethod(this: MarketControlPlaneStore, id: string, input: any) {
	await this.ensureInitialized();
	const current = await this.getKnowledgePackBuild(id);
	if (!current) return { ok: false, code: 'missing' };
	if (input.expectedStatus && current.status !== input.expectedStatus) return { ok: false, code: 'stale', build: current };
	const completedAt = ['completed', 'failed', 'cancelled', 'expired'].includes(input.status) ? isoNow() : current.completedAt ?? null;
	const result = await this.run(`UPDATE knowledge_pack_builds SET status = ?, source_closure = ?,
		artifact_json = ?, error = ?, version = version + 1, updated_at = ?, completed_at = ?
		WHERE id = ? AND version = ?`, [input.status ?? current.status, input.sourceClosure ?? current.sourceClosure ?? null,
		JSON.stringify(input.artifact ?? current.artifact ?? {}), input.error ?? null, isoNow(), completedAt, id, current.version]);
	return Number(result.meta?.changes ?? 0) === 1
		? { ok: true, build: await this.getKnowledgePackBuild(id) }
		: { ok: false, code: 'stale', build: await this.getKnowledgePackBuild(id) };
}
