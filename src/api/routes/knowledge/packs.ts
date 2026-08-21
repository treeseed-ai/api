import { createPrivateObjectStorage } from '../../storage/private-object-storage.ts';
import { createHash } from 'node:crypto';
import { loadFederatedKnowledgeCatalog } from '../../knowledge/federated-catalog.ts';
import { createKnowledgePublicationStorage } from '../../knowledge/publication-storage.ts';

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const ids = (value: unknown) => [...new Set((Array.isArray(value) ? value : [])
	.map((item) => text(item)).filter(Boolean))];

function publicBuild(build: any) {
	if (!build) return null;
	if (!build.artifact) return build;
	const { storageKey: _storageKey, ...artifact } = build.artifact ?? {};
	return { ...build, artifact };
}

async function validBookIds(context: any, c: any, teamId: string, requested: string[]) {
	if (!requested.length) return { error: context.jsonError(c, 422, 'Select at least one published book.', { fieldErrors: { bookIds: 'Select at least one book.' } }) };
	if (requested.length > 100) return { error: context.jsonError(c, 422, 'A collection can contain at most 100 books.') };
	const catalog = await loadFederatedKnowledgeCatalog(context, c);
	if (catalog.response) return { error: catalog.response };
	const available = new Set(catalog.books.filter((book: any) => book.source.teamId === teamId
		&& book.status === 'published' && book.packPolicy !== 'disabled').map((book: any) => book.id));
	const unavailable = requested.filter((id) => !available.has(id));
	if (unavailable.length) return { error: context.jsonError(c, 422, 'One or more books are unavailable for packing.', {
		code: 'knowledge_books_unavailable', fieldErrors: { bookIds: 'Choose published, pack-enabled books from this team.' },
	}) };
	return { bookIds: requested };
}

export function installKnowledgePackRoutes(context: any) {
	const { app, jsonError, store } = context;

	app.get('/v1/teams/:teamId/knowledge/collections', async (c: any) => {
		const access = await context.requireTeamAccess(c, store, c.req.param('teamId'), 'knowledge:read');
		if (access.response) return access.response;
		return c.json({ ok: true, payload: await store.listBookCollections(c.req.param('teamId')) });
	});

	app.post('/v1/teams/:teamId/knowledge/collections', async (c: any) => {
		const teamId = c.req.param('teamId');
		const access = await context.requireTeamAccess(c, store, teamId, 'knowledge:manage-books');
		if (access.response) return access.response;
		const body = await c.req.json().catch(() => ({}));
		const name = text(body.name);
		if (!name || name.length > 120) return jsonError(c, 422, 'Enter a collection name of 120 characters or fewer.', { fieldErrors: { name: 'Enter a collection name.' } });
		const selection = await validBookIds(context, c, teamId, ids(body.bookIds));
		if (selection.error) return selection.error;
		try {
			const collection = await store.createBookCollection({ teamId, name, summary: text(body.summary) || null,
				bookIds: selection.bookIds, createdByUserId: access.principal.id });
			await store.recordAuditEvent({ eventType: 'knowledge.collection.created', actorType: 'user', actorId: access.principal.id,
				targetType: 'book_collection', targetId: collection.id, data: { teamId, bookIds: collection.bookIds } });
			return c.json({ ok: true, payload: collection }, 201);
		} catch (error: any) {
			if (String(error?.code ?? '').includes('unique')) return jsonError(c, 409, 'A collection with this name already exists.', { fieldErrors: { name: 'Choose a unique collection name.' } });
			throw error;
		}
	});

	app.put('/v1/knowledge/collections/:collectionId', async (c: any) => {
		const current = await store.getBookCollection(c.req.param('collectionId'));
		if (!current) return jsonError(c, 404, 'Book collection not found.');
		if (current.managed) return jsonError(c, 403, 'Managed platform collections cannot be edited.', { code: 'managed_book_collection' });
		const access = await context.requireTeamAccess(c, store, current.teamId, 'knowledge:manage-books');
		if (access.response) return access.response;
		const body = await c.req.json().catch(() => ({}));
		const name = text(body.name);
		if (!name || name.length > 120) return jsonError(c, 422, 'Enter a collection name of 120 characters or fewer.', { fieldErrors: { name: 'Enter a collection name.' } });
		const selection = await validBookIds(context, c, current.teamId, ids(body.bookIds));
		if (selection.error) return selection.error;
		const result = await store.updateBookCollection(current.id, { version: Number(body.version), name,
			summary: text(body.summary) || null, bookIds: selection.bookIds });
		if (!result.ok) return jsonError(c, result.code === 'missing' ? 404 : 409, result.code === 'missing' ? 'Book collection not found.' : 'The collection changed. Reload before saving.', { code: result.code });
		return c.json({ ok: true, payload: result.collection });
	});

	app.delete('/v1/knowledge/collections/:collectionId', async (c: any) => {
		const current = await store.getBookCollection(c.req.param('collectionId'));
		if (!current) return jsonError(c, 404, 'Book collection not found.');
		if (current.managed) return jsonError(c, 403, 'Managed platform collections cannot be deleted.', { code: 'managed_book_collection' });
		const access = await context.requireTeamAccess(c, store, current.teamId, 'knowledge:manage-books');
		if (access.response) return access.response;
		const body = await c.req.json().catch(() => ({}));
		const result = await store.deleteBookCollection(current.id, Number(body.version));
		if (!result.ok) return jsonError(c, 409, 'The collection changed. Reload before deleting.', { code: 'stale_book_collection' });
		await store.recordAuditEvent({ eventType: 'knowledge.collection.deleted', actorType: 'user', actorId: access.principal.id,
			targetType: 'book_collection', targetId: current.id, data: { teamId: current.teamId } });
		return c.json({ ok: true, payload: { id: current.id } });
	});

	app.get('/v1/teams/:teamId/knowledge/packs', async (c: any) => {
		const access = await context.requireTeamAccess(c, store, c.req.param('teamId'), 'knowledge:read');
		if (access.response) return access.response;
		return c.json({ ok: true, payload: (await store.listKnowledgePackBuilds(c.req.param('teamId'))).map(publicBuild) });
	});

	app.post('/v1/teams/:teamId/knowledge/packs', async (c: any) => {
		const teamId = c.req.param('teamId');
		const access = await context.requireTeamAccess(c, store, teamId, 'knowledge:build-packs');
		if (access.response) return access.response;
		const body = await c.req.json().catch(() => ({}));
		const collection = text(body.collectionId) ? await store.getBookCollection(text(body.collectionId)) : null;
		if (text(body.collectionId) && (!collection || collection.teamId !== teamId)) return jsonError(c, 404, 'Book collection not found.');
		const selection = await validBookIds(context, c, teamId, collection?.bookIds ?? ids(body.bookIds));
		if (selection.error) return selection.error;
		const manifest = await createKnowledgePublicationStorage({ adapter: context.options?.knowledgePublicationStorage,
			environment: context.options?.environment }).readCurrent(teamId).catch(() => null);
		if (!manifest) return jsonError(c, 409, 'Publish the team knowledge library before building a knowledge pack.',
			{ code: 'knowledge_publication_required' });
		const build = await store.createKnowledgePackBuild({ teamId, collectionId: collection?.id,
			requestedByUserId: access.principal.id, bookIds: selection.bookIds,
			publicationRevision: manifest.revision });
		const operation = await store.createPlatformOperation({ namespace: 'knowledge', operation: 'build_pack',
			target: 'control_plane_operations_runner', idempotencyKey: `knowledge-pack:${build.id}`,
			input: { buildId: build.id }, requestedByType: 'user', requestedById: access.principal.id });
		return c.json({ ok: true, code: 'knowledge_pack_queued', message: 'Knowledge-pack build queued.',
			payload: { build: publicBuild(build), operation } }, 202);
	});

	app.get('/v1/knowledge/packs/:buildId', async (c: any) => {
		const build = await store.getKnowledgePackBuild(c.req.param('buildId'));
		if (!build) return jsonError(c, 404, 'Knowledge pack not found.');
		const access = await context.requireTeamAccess(c, store, build.teamId, 'knowledge:read');
		if (access.response) return access.response;
		return c.json({ ok: true, payload: publicBuild(build) }, 200, { 'Cache-Control': 'private, no-store' });
	});

	app.post('/v1/teams/:teamId/knowledge/packs/cleanup', async (c: any) => {
		const teamId = c.req.param('teamId');
		const access = await context.requireTeamAccess(c, store, teamId, 'knowledge:manage-books');
		if (access.response) return access.response;
		const operation = await store.createPlatformOperation({ namespace: 'knowledge', operation: 'cleanup_packs',
			target: 'control_plane_operations_runner', idempotencyKey: `knowledge-pack-cleanup:${teamId}:${new Date().toISOString().slice(0, 10)}`,
			input: { teamId }, requestedByType: 'user', requestedById: access.principal.id });
		return c.json({ ok: true, code: 'knowledge_pack_cleanup_queued', message: 'Knowledge-pack retention cleanup queued.',
			payload: { operation } }, 202);
	});

	app.post('/v1/knowledge/packs/:buildId/cancel', async (c: any) => {
		const build = await store.getKnowledgePackBuild(c.req.param('buildId'));
		if (!build) return jsonError(c, 404, 'Knowledge pack not found.');
		const access = await context.requireTeamAccess(c, store, build.teamId, 'knowledge:build-packs');
		if (access.response) return access.response;
		if (build.status !== 'queued') return jsonError(c, 409, 'Only a queued knowledge-pack build can be cancelled.',
			{ code: 'knowledge_pack_not_cancellable' });
		const cancelled = await store.updateKnowledgePackBuild(build.id, { expectedStatus: 'queued', status: 'cancelled' });
		if (!cancelled.ok) return jsonError(c, 409, 'The knowledge-pack build changed before cancellation.');
		await store.recordAuditEvent({ eventType: 'knowledge.pack.cancelled', actorType: 'user', actorId: access.principal.id,
			targetType: 'knowledge_pack', targetId: build.id, data: { teamId: build.teamId,
				publicationRevision: build.publicationRevision } });
		return c.json({ ok: true, payload: publicBuild(cancelled.build) });
	});

	app.get('/v1/knowledge/packs/:buildId/download', async (c: any) => {
		const build = await store.getKnowledgePackBuild(c.req.param('buildId'));
		if (!build) return jsonError(c, 404, 'Knowledge pack not found.');
		const access = await context.requireTeamAccess(c, store, build.teamId, 'knowledge:build-packs');
		if (access.response) return access.response;
		if (build.status !== 'completed' || !build.artifact?.storageKey) return jsonError(c, 409, 'The knowledge pack is not ready.');
		if (build.artifact.expiresAt && build.artifact.expiresAt <= new Date().toISOString()) {
			return jsonError(c, 410, 'The knowledge-pack artifact has expired.', { code: 'knowledge_pack_expired' });
		}
		const object = await createPrivateObjectStorage({ adapter: context.options?.privateObjectStorage }).get(build.artifact.storageKey);
		if (!object) return jsonError(c, 410, 'The knowledge-pack artifact is no longer available.');
		const actualDigest = createHash('sha256').update(object.bytes).digest('hex');
		if (actualDigest !== build.artifact.digest || object.bytes.byteLength !== Number(build.artifact.byteSize)) {
			return jsonError(c, 410, 'The knowledge-pack artifact failed integrity verification.',
				{ code: 'knowledge_pack_corrupt' });
		}
		return new Response(object.bytes, { headers: { 'Content-Type': 'application/zip', 'Cache-Control': 'private, no-store',
			'Content-Disposition': `attachment; filename="${String(build.artifact.fileName).replaceAll('"', '')}"` } });
	});
}
