import { parseBook, parseKnowledgePage } from '../../knowledge/runtime/catalog.ts';
import { serializeBookDraft, serializeKnowledgePageDraft } from '../../knowledge/runtime/authoring.ts';
import { loadFederatedKnowledgeCatalog } from '../../knowledge/federated-catalog.ts';
import { resolveKnowledgeGatewayConnection } from '../../knowledge/gateway-treedx-connection.ts';
import { treeDxWorkspaceId } from '../../knowledge/workspace-identity.ts';
import { applyTextChangeset } from '../../knowledge/changesets/apply-text-changeset.ts';

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const requestId = (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(text(value))
	? text(value) : '';

function safePath(contentPath: string, path: string) {
	return Boolean(path) && !path.startsWith('/') && !path.split('/').some((part) => !part || part === '.' || part === '..')
		&& [`${contentPath}/books/`, `${contentPath}/knowledge/`].some((root) => path.startsWith(root));
}

async function lifecycleContext(context: any, c: any) {
	const access = await context.requireProjectAccess(c, context.store, c.req.param('projectId'), 'knowledge:manage-books');
	if (access.response) return access;
	const connection = await resolveKnowledgeGatewayConnection(context.store, { projectId: access.details.project.id, write: false });
	if (!connection) return { response: context.jsonError(c, 503, 'The project knowledge repository is unavailable.') };
	const path = text(c.req.query('path'));
	if (!safePath(connection.contentPath, path)) return { response: context.jsonError(c, 422, 'Choose a book or knowledge page in this project.') };
	const file = await connection.client.readRepositoryFiles({ repoId: connection.repositoryId, ref: connection.baseRef,
		paths: [path], parseFrontmatter: false });
	const document = file.files?.[0];
	if (!document?.content) return { response: context.jsonError(c, 404, 'Knowledge content not found.') };
	const kind = path.startsWith(`${connection.contentPath}/books/`) ? 'book' : 'page';
	const definition: any = kind === 'book' ? parseBook({ path, raw: document.content }) : parseKnowledgePage({ path, raw: document.content });
	return { ...access, connection, path, kind, definition, source: document.content, expectedSha: document.sha };
}

async function dependencies(context: any, c: any, item: any) {
	const catalog = await loadFederatedKnowledgeCatalog(context, c, item.details.project.id);
	if (catalog.response) throw new Error('The authorized knowledge dependency graph is unavailable.');
	const bookPages = item.kind === 'book' ? catalog.pages.filter((page: any) => page.bookId === item.definition.id && page.status === 'published') : [];
	const backlinks = item.kind === 'book'
		? catalog.books.filter((book: any) => book.relatedBookIds.includes(item.definition.id))
		: catalog.pages.filter((page: any) => page.relatedKnowledgeIds.includes(item.definition.id));
	const collections = (await context.store.listBookCollections(item.details.project.teamId))
		.filter((collection: any) => item.kind === 'book' && collection.bookIds.includes(item.definition.id));
	const parent = item.kind === 'page' ? catalog.books.find((book: any) => book.id === item.definition.bookId) : null;
	return { bookPages: bookPages.map((page: any) => ({ id: page.id, title: page.title,
		resolutionHref: `/app/knowledge?project=${encodeURIComponent(item.details.project.id)}&sourcePath=${encodeURIComponent(page.source.path)}&kind=page` })),
		backlinks: backlinks.map((entry: any) => ({ id: entry.id, title: entry.title,
			resolutionHref: entry.canonicalPath })),
		collections: collections.map((collection: any) => ({ id: collection.id, name: collection.name,
			resolutionHref: '/app/knowledge?view=packs' })),
		parentArchived: parent?.status === 'archived' };
}

function lifecycleDocument(item: any, status: 'published' | 'archived') {
	if (item.kind === 'book') return serializeBookDraft({ ...item.definition, status });
	const { schemaVersion: _schema, bodyHtml: _html, revision: _revision, sourcePackage: _source, updatedAt: _updated, ...definition } = item.definition;
	return serializeKnowledgePageDraft({ ...definition, status });
}

export function installKnowledgeLifecycleRoutes(context: any) {
	const { app, jsonError, store } = context;
	app.get('/v1/projects/:projectId/knowledge/lifecycle', async (c: any) => {
		const item = await lifecycleContext(context, c);
		if (item.response) return item.response;
		try { return c.json({ ok: true, payload: { kind: item.kind, path: item.path, definition: item.definition,
			expectedSha: item.expectedSha, dependencies: await dependencies(context, c, item) } }); }
		catch { return jsonError(c, 503, 'Knowledge dependencies are unavailable. Archive and restore fail closed.'); }
	});

	app.post('/v1/projects/:projectId/knowledge/lifecycle', async (c: any) => {
		const item = await lifecycleContext(context, c);
		if (item.response) return item.response;
		const body = await c.req.json().catch(() => ({}));
		const action = text(body.action);
		if (!['archive', 'restore'].includes(action)) return jsonError(c, 422, 'Choose archive or restore.');
		const suppliedRequestId = text(body.requestId);
		const id = suppliedRequestId ? requestId(suppliedRequestId) : crypto.randomUUID();
		if (!id) return jsonError(c, 422, 'A valid lifecycle request identifier is required.', { code: 'knowledge_request_id_invalid' });
		const existing = await store.getKnowledgeWorkspace(id);
		if (existing) {
			if (existing.projectId !== item.details.project.id || existing.actorUserId !== item.principal.id) {
				return jsonError(c, 409, 'This lifecycle request identifier is already in use.', { code: 'knowledge_request_id_conflict' });
			}
			return c.json({ ok: true, code: 'knowledge_lifecycle_draft_already_created',
				message: 'Lifecycle draft already created. Continue its independent review.', payload: { workspace: existing, action } });
		}
		const targetStatus = action === 'archive' ? 'archived' : 'published';
		if (item.definition.status === targetStatus) return jsonError(c, 409, `This ${item.kind} is already ${targetStatus}.`);
		let found;
		try { found = await dependencies(context, c, item); }
		catch { return jsonError(c, 503, 'Knowledge dependencies are unavailable. Archive and restore fail closed.'); }
		if (action === 'archive' && (found.bookPages.length || found.backlinks.length || found.collections.length)) {
			return jsonError(c, 409, 'Resolve the listed knowledge dependencies before archiving.', {
				code: 'knowledge_archive_blocked', blockers: found,
			});
		}
		if (action === 'restore' && found.parentArchived) return jsonError(c, 409, 'Restore the owning book before restoring this page.', {
			code: 'knowledge_parent_archived', blockers: found,
		});
		const branchName = `refs/heads/knowledge/${id}`;
		const writeConnection = await resolveKnowledgeGatewayConnection(store, {
			projectId: item.details.project.id, write: true, workspaceRefs: [branchName],
		});
		if (!writeConnection) return jsonError(c, 503, 'The project knowledge repository is unavailable.');
		const remote = await writeConnection.client.createWorkspace({ workspaceId: treeDxWorkspaceId(id), repoId: writeConnection.repositoryId,
			baseRef: writeConnection.baseRef, branchName, mode: 'writable', allowedPaths: writeConnection.allowedPaths, ttlSeconds: 86_400 });
		let written = false;
		try {
			await applyTextChangeset({ client: writeConnection.client, workspace: remote, changes: [{
				path: item.path, before: item.source, after: lifecycleDocument(item, targetStatus),
			}], idempotencyKey: `knowledge-lifecycle-${id}` });
			written = true;
			const workspace = await store.createKnowledgeWorkspaceRecord({ id, teamId: item.details.project.teamId,
				projectId: item.details.project.id, repositoryId: writeConnection.repositoryId,
				treeDxWorkspaceId: remote.workspaceId, actorUserId: item.principal.id, baseRef: remote.baseRef,
				baseCommitSha: remote.baseCommitSha, branchName: remote.branchName ?? branchName,
				allowedPaths: writeConnection.allowedPaths });
			await store.recordAuditEvent({ id: `knowledge-lifecycle-prepared-${workspace.id}`,
				eventType: 'knowledge.lifecycle.prepared', actorType: 'user', actorId: item.principal.id,
				targetType: item.kind === 'book' ? 'book' : 'knowledge_page', targetId: item.definition.id,
				data: { projectId: item.details.project.id, workspaceId: workspace.id, action, path: item.path } });
			return c.json({ ok: true, code: 'knowledge_lifecycle_draft_created', message: `${action === 'archive' ? 'Archive' : 'Restore'} draft created. Submit it for independent review.`,
				payload: { workspace, action, dependencies: found } }, 201);
		} catch (error) {
			if (!written) await writeConnection.client.closeWorkspace(remote.workspaceId).catch(() => undefined);
			throw error;
		}
	});
}
