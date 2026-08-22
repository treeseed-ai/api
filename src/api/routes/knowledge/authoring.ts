import { loadFederatedKnowledgeCatalog } from '../../knowledge/federated-catalog.ts';
import { resolveKnowledgeGatewayConnection } from '../../knowledge/gateway-treedx-connection.ts';
import { createRevisionWorkspace, currentReviewIds, discardRevisionWorkspace, reviewWorkspaceAvailable } from '../../knowledge/review-revision.ts';
import { treeDxWorkspaceId } from '../../knowledge/workspace-identity.ts';
import { editorialReviewGate, editorialSubmissionRequirements, requiredRevisionReviewerIds, verifiedEditorialContextTrace } from '../../knowledge/editorial-review.ts';
import { RelationContentValidationError,relationKinds, reviewPathsMatch, searchRelations } from './relation-search.ts';
import { allowedWorkspacePath, assertSimulatedProductionPolicy, authorizedCatalog, bookDocument, list, pageDocument, parseBook, parseKnowledgePage, requestId, text, workspaceAccess } from './authoring-support.ts';
import { projectTreeDxCommitSignals } from '../../capacity/services/treedx/repositories/treedx-change-projector.ts';
import { recordTreeDxAuthoringState } from '../../capacity/services/treedx/repositories/treedx-authoring-journal.ts';
import { applyTextChangeset } from '../../knowledge/changesets/apply-text-changeset.ts';
export { reviewPathsMatch, searchRelations } from './relation-search.ts';

export function installKnowledgeAuthoringRoutes(context: any) {
	const { app, jsonError, requireProjectAccess, store } = context;

	app.get('/v1/projects/:projectId/knowledge/relations/search', async (c: any) => {
		const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'knowledge:link');
		if (access.response) return access.response;
		const query = text(c.req.query('q')).slice(0, 120);
		if (query.length < 2) return c.json({ ok: true, payload: { results: [] } });
		const requested = new Set(list(c.req.query('types')).filter((kind) => relationKinds.has(kind)));
		const connection = await resolveKnowledgeGatewayConnection(store, { projectId: access.details.project.id, write: false, relationPaths: true });
		if (!connection) return jsonError(c, 503, 'The project knowledge graph is unavailable.');
		try {
			return c.json({ ok: true, payload: { results: await searchRelations(connection, query, requested) } });
		} catch (error) {
			if (error instanceof RelationContentValidationError) return jsonError(c,error.status,error.message,{code:error.code,diagnostics:error.diagnostics});
			return jsonError(c, 503, 'Knowledge relationship search is unavailable.', { code: 'knowledge_relation_search_unavailable' });
		}
	});

	app.post('/v1/projects/:projectId/knowledge/workspaces', async (c: any) => {
		const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'knowledge:author');
		if (access.response) return access.response;
		const body = await c.req.json().catch(() => ({}));
		const suppliedRequestId = text(body.requestId);
		const id = suppliedRequestId ? requestId(suppliedRequestId) : crypto.randomUUID();
		if (!id) return jsonError(c, 422, 'A valid authoring request identifier is required.', { code: 'knowledge_request_id_invalid' });
		const existing = await store.getKnowledgeWorkspace(id);
		if (existing) {
			if (existing.projectId !== access.details.project.id || existing.actorUserId !== access.principal.id) {
				return jsonError(c, 409, 'This authoring request identifier is already in use.', { code: 'knowledge_request_id_conflict' });
			}
			return c.json({ ok: true, code: 'knowledge_workspace_already_created', payload: existing });
		}
		const branchName = `refs/heads/knowledge/${id}`;
		const connection = await resolveKnowledgeGatewayConnection(store, {
			projectId: access.details.project.id, write: true, workspaceRefs: [branchName],
		});
		if (!connection) return jsonError(c, 503, 'The project knowledge repository is unavailable.', { code: 'knowledge_repository_unavailable' });
		let remote;
		try {
			remote = await connection.client.createWorkspace({ workspaceId: treeDxWorkspaceId(id),
				repoId: connection.repositoryId, baseRef: connection.baseRef, branchName,
				mode: 'writable', allowedPaths: connection.allowedPaths, ttlSeconds: 86_400,
			});
		} catch {
			return jsonError(c, 503, 'The project knowledge workspace could not be created.', { code: 'knowledge_workspace_unavailable' });
		}
		const workspace = await store.createKnowledgeWorkspaceRecord({ id,
			teamId: access.details.project.teamId, projectId: access.details.project.id,
			repositoryId: connection.repositoryId, treeDxWorkspaceId: remote.workspaceId,
			actorUserId: access.principal.id, baseRef: remote.baseRef, baseCommitSha: remote.baseCommitSha,
			branchName: remote.branchName ?? branchName, allowedPaths: connection.allowedPaths,
		});
		await store.recordAuditEvent({ id: `knowledge-workspace-created-${workspace.id}`,
			eventType: 'knowledge.workspace.created', actorType: 'user', actorId: access.principal.id,
			targetType: 'knowledge_workspace', targetId: workspace.id, data: { teamId: workspace.teamId, projectId: workspace.projectId, repositoryId: workspace.repositoryId } });
		return c.json({ ok: true, payload: workspace }, 201);
	});

	app.get('/v1/knowledge/workspaces/:workspaceId', async (c: any) => {
		const access = await workspaceAccess(context, c, 'knowledge:read');
		if (access.response) return access.response;
		return c.json({ ok: true, payload: { ...access.workspace,
			presence: await store.listKnowledgeWorkspacePresence(access.workspace.id) } });
	});

	app.post('/v1/knowledge/workspaces/:workspaceId/presence', async (c: any) => {
		const access = await workspaceAccess(context, c, 'knowledge:read');
		if (access.response) return access.response;
		return c.json({ ok: true, payload: await store.heartbeatKnowledgeWorkspace(access.workspace.id, access.principal.id) });
	});

	app.get('/v1/knowledge/workspaces/:workspaceId/relations/search', async (c: any) => {
		const access = await workspaceAccess(context, c, 'knowledge:link');
		if (access.response) return access.response;
		if (access.workspace.actorUserId !== access.principal.id) return jsonError(c, 404, 'Knowledge workspace not found.');
		const query = text(c.req.query('q')).slice(0, 120);
		if (query.length < 2) return c.json({ ok: true, payload: { results: [] } });
		const requested = new Set(list(c.req.query('types')).filter((kind) => relationKinds.has(kind)));
		const connection = await resolveKnowledgeGatewayConnection(store, { projectId: access.workspace.projectId, write: false, relationPaths: true });
		if (!connection) return jsonError(c, 503, 'The project knowledge graph is unavailable.');
		try { return c.json({ ok: true, payload: { results: await searchRelations(connection, query, requested) } }); }
		catch (error) {
			if (error instanceof RelationContentValidationError) return jsonError(c,error.status,error.message,{code:error.code,diagnostics:error.diagnostics});
			return jsonError(c, 503, 'Knowledge relationship search is unavailable.', { code: 'knowledge_relation_search_unavailable' });
		}
	});

	app.get('/v1/knowledge/workspaces/:workspaceId/content', async (c: any) => {
		const access = await workspaceAccess(context, c, 'knowledge:read');
		if (access.response) return access.response;
		const path = text(c.req.query('path'));
		if (!allowedWorkspacePath(access.workspace, path)) return jsonError(c, 422, 'Choose a knowledge file in this project workspace.', { code: 'knowledge_path_invalid' });
		const connection = await resolveKnowledgeGatewayConnection(store, { projectId: access.workspace.projectId,
			write: false, workspaceRefs: [access.workspace.branchName] });
		if (!connection) return jsonError(c, 503, 'The project knowledge repository is unavailable.');
		const file = await connection.client.readFile({ workspaceId: access.workspace.treeDxWorkspaceId, path });
		try {
			const isBook = path.startsWith(`${connection.contentPath}/books/`);
			const definition = isBook ? parseBook({ path, raw: file.content }) : parseKnowledgePage({ path, raw: file.content });
			let backlinks: any[] = [];
			if (!isBook) {
				const catalog = await loadFederatedKnowledgeCatalog(context, c, access.workspace.projectId);
				if (catalog.response) return catalog.response;
				const visible = await authorizedCatalog(context, c, catalog);
				backlinks = visible.pages.filter((page: any) => page.relatedKnowledgeIds.includes((definition as any).id)).map((page: any) => ({
					id: page.id, title: page.title, summary: page.summary,
					canonicalPath: `/t/${encodeURIComponent(page.source.teamSlug)}/books/${encodeURIComponent(page.source.bookSlug ?? page.bookId)}/${page.slug.split('/').map(encodeURIComponent).join('/')}`,
				}));
			}
			return c.json({ ok: true, payload: { kind: isBook ? 'book' : 'page', path, expectedSha: file.sha, definition, backlinks } });
		} catch (error) {
			return jsonError(c, 422, error instanceof Error ? error.message : 'The knowledge file is invalid.', { code: 'knowledge_content_invalid' });
		}
	});

	app.put('/v1/knowledge/workspaces/:workspaceId/content', async (c: any) => {
		const access = await workspaceAccess(context, c, 'knowledge:author');
		if (access.response) return access.response;
		if (access.workspace.actorUserId !== access.principal.id) return jsonError(c, 403, 'Only the workspace author can edit this draft.');
		if (!['draft', 'changes-requested'].includes(access.workspace.status)) {
			return jsonError(c, 409, 'This draft is locked while it is in review or publication.', { code: 'knowledge_workspace_locked' });
		}
		const body = await c.req.json().catch(() => ({}));
		if (Number(body.version) !== access.workspace.version) return jsonError(c, 409, 'The draft changed. Reload before saving.', { code: 'stale_workspace', workspace: access.workspace });
		let content: string;
		let before: string | null = null;
		try {
			let status: 'published' | 'archived' = 'published';
			if (text(body.sourcePath)) {
				const readConnection = await resolveKnowledgeGatewayConnection(store, { projectId: access.workspace.projectId,
					write: false, workspaceRefs: [access.workspace.branchName] });
				if (!readConnection) return jsonError(c, 503, 'The project knowledge repository is unavailable.');
				const current = await readConnection.client.readFile({ workspaceId: access.workspace.treeDxWorkspaceId,
					path: text(body.sourcePath) });
				before = current.content;
				const definition = body.kind === 'book' ? parseBook({ path: text(body.sourcePath), raw: current.content })
					: parseKnowledgePage({ path: text(body.sourcePath), raw: current.content });
				status = definition.status === 'archived' ? 'archived' : 'published';
			}
			content = body.kind === 'book' ? bookDocument(body, status) : pageDocument(body, status);
		}
		catch (error) { return jsonError(c, 422, error instanceof Error ? error.message : 'Invalid knowledge content.', { code: 'invalid_knowledge_content' }); }
		const connection = await resolveKnowledgeGatewayConnection(store, { projectId: access.workspace.projectId,
			write: true, workspaceRefs: [access.workspace.branchName] });
		if (!connection) return jsonError(c, 503, 'The project knowledge repository is unavailable.');
		const slug = text(body.slug);
		const derivedPath = body.kind === 'book'
			? `${connection.contentPath}/books/${slug}.md`
			: `${connection.contentPath}/knowledge/${text(body.bookId)}/${slug}.md`;
		const path = text(body.sourcePath) || derivedPath;
		if (!allowedWorkspacePath(access.workspace, path)) return jsonError(c, 422, 'The knowledge path is outside this workspace.', { code: 'knowledge_path_invalid' });
		if (text(body.sourcePath) && path !== derivedPath) return jsonError(c, 422, 'Changing a knowledge path requires an explicit move operation.', { code: 'knowledge_path_move_required' });
		const result = await applyTextChangeset({ client: connection.client, workspace: {
			workspaceId: access.workspace.treeDxWorkspaceId,
			baseCommitSha: access.workspace.baseCommitSha,
			baseRef: access.workspace.baseRef,
		}, changes: [{ path, before, after: content }], idempotencyKey: `knowledge-content-${access.workspace.id}-${access.workspace.version}` });
		const updated = await store.updateKnowledgeWorkspace(access.workspace.id, { version: access.workspace.version, status: 'draft' });
		if (!updated.ok) return jsonError(c, 409, 'The draft changed. Reload before saving.', { code: 'stale_workspace', workspace: updated.workspace });
		await store.recordAuditEvent({ eventType: body.kind === 'book' ? 'knowledge.book.updated' : 'knowledge.page.updated', actorType: 'user', actorId: access.principal.id,
			targetType: body.kind === 'book' ? 'book' : 'knowledge_page', targetId: text(body.id), data: { workspaceId: access.workspace.id, projectId: access.workspace.projectId, path } });
		return c.json({ ok: true, payload: { result, workspace: updated.workspace } });
	});

	app.get('/v1/knowledge/workspaces/:workspaceId/diff', async (c: any) => {
		const access = await workspaceAccess(context, c, 'knowledge:read');
		if (access.response) return access.response;
		const connection = await resolveKnowledgeGatewayConnection(store, { projectId: access.workspace.projectId,
			write: false, workspaceRefs: [access.workspace.branchName] });
		if (!connection) return jsonError(c, 503, 'The project knowledge repository is unavailable.');
		return c.json({ ok: true, payload: await connection.client.diff({ workspaceId: access.workspace.treeDxWorkspaceId }) });
	});

	app.post('/v1/knowledge/workspaces/:workspaceId/abandon', async (c: any) => {
		const access = await workspaceAccess(context, c, 'knowledge:author');
		if (access.response) return access.response;
		if (access.workspace.actorUserId !== access.principal.id) return jsonError(c, 403, 'Only the workspace author can abandon this draft.');
		if (!['draft', 'changes-requested'].includes(access.workspace.status)) {
			return jsonError(c, 409, 'A submitted or published workspace cannot be abandoned.', { code: 'knowledge_workspace_locked' });
		}
		const body = await c.req.json().catch(() => ({}));
		if (Number(body.version) !== access.workspace.version) return jsonError(c, 409, 'The draft changed. Reload before abandoning it.', { code: 'stale_workspace' });
		const connection = await resolveKnowledgeGatewayConnection(store, { projectId: access.workspace.projectId,
			write: true, workspaceRefs: [access.workspace.branchName] });
		if (!connection) return jsonError(c, 503, 'The project knowledge repository is unavailable.');
		await connection.client.closeWorkspace(access.workspace.treeDxWorkspaceId);
		const updated = await store.updateKnowledgeWorkspace(access.workspace.id, { version: access.workspace.version, status: 'abandoned' });
		if (!updated.ok) return jsonError(c, 409, 'The draft changed. Reload before abandoning it.', { code: 'stale_workspace' });
		await store.recordAuditEvent({ eventType: 'knowledge.workspace.abandoned', actorType: 'user', actorId: access.principal.id,
			targetType: 'knowledge_workspace', targetId: access.workspace.id, data: { projectId: access.workspace.projectId } });
		return c.json({ ok: true, payload: updated.workspace });
	});

	app.post('/v1/knowledge/workspaces/:workspaceId/submit', async (c: any) => {
		const access = await workspaceAccess(context, c, 'knowledge:author');
		if (access.response) return access.response;
		if (access.workspace.actorUserId !== access.principal.id) return jsonError(c, 403, 'Only the workspace author can submit this draft.');
		const existingReview = await store.getKnowledgeReviewByWorkspace(access.workspace.id);
		if (access.workspace.status === 'submitted' && existingReview) {
			await store.recordAuditEvent({ id: `knowledge-review-submitted-${existingReview.id}`,
				eventType: 'knowledge.review.submitted', actorType: 'user', actorId: access.principal.id,
				targetType: 'knowledge_review', targetId: existingReview.id, data: { workspaceId: access.workspace.id,
					projectId: access.workspace.projectId, commitSha: existingReview.commitSha } });
			return c.json({ ok: true, code: 'knowledge_review_already_submitted',
				payload: { review: existingReview, commit: { commitSha: existingReview.commitSha,
					branchName: access.workspace.branchName, changedPaths: existingReview.changedPaths, status: 'committed' } } });
		}
		if (!['draft', 'changes-requested'].includes(access.workspace.status)) {
			return jsonError(c, 409, 'This workspace has already been submitted.', { code: 'knowledge_workspace_locked' });
		}
		const body = await c.req.json().catch(() => ({}));
		if (Number(body.version) !== access.workspace.version) return jsonError(c, 409, 'The draft changed. Reload before submitting.', { code: 'stale_workspace' });
		const connection = await resolveKnowledgeGatewayConnection(store, { projectId: access.workspace.projectId,
			write: true, workspaceRefs: [access.workspace.branchName] });
		if (!connection) return jsonError(c, 503, 'The project knowledge repository is unavailable.');
		const diff = await connection.client.diff({ workspaceId: access.workspace.treeDxWorkspaceId });
		if (!diff.changedPaths.length) return jsonError(c, 422, 'The draft has no changes.', { code: 'empty_knowledge_draft' });
		const editorial = editorialSubmissionRequirements(diff.changedPaths, body.contextDigest);
		if (editorial.error) return jsonError(c, 422, editorial.error, { code: 'editorial_context_required' });
		if (editorial.requiresEditorialReview && !(await verifiedEditorialContextTrace(store, access.workspace.projectId, editorial.contextDigest))) {
			return jsonError(c, 409, 'The editorial context digest is not backed by a successful Guide authoring trace for this project.', { code: 'editorial_context_trace_required' });
		}
		const remoteStatus = await connection.client.status({ workspaceId: access.workspace.treeDxWorkspaceId });
		const commit = remoteStatus.status === 'committed' && remoteStatus.commitSha
			? { repoId: access.workspace.repositoryId, workspaceId: access.workspace.treeDxWorkspaceId,
				branchName: remoteStatus.branchName ?? access.workspace.branchName, commitSha: remoteStatus.commitSha,
				changedPaths: diff.changedPaths, status: 'committed' as const }
			: await connection.client.commit({ workspaceId: access.workspace.treeDxWorkspaceId,
				message: text(body.message) || 'Update knowledge', author: { name: text(access.principal.name) || access.principal.id,
					email: text(access.principal.email) || `${access.principal.id}@users.treeseed.local` } });
		const requiredReviewerIds = requiredRevisionReviewerIds(existingReview);
		await recordTreeDxAuthoringState(store,'unpublished',{ projectId:access.workspace.projectId,repositoryId:access.workspace.repositoryId,commitSha:commit.commitSha,ref:commit.branchName,changedPaths:diff.changedPaths,actorType:'user',actorId:access.principal.id });
		await projectTreeDxCommitSignals(store, { projectId: access.workspace.projectId, commitSha: commit.commitSha, immutableRef: commit.branchName, changedPaths: diff.changedPaths, changeSummary: text(body.message) || 'Update knowledge', actorType: 'user', actorId: access.principal.id });
		const submitted = await store.submitKnowledgeWorkspace({ workspaceId: access.workspace.id,
			workspaceVersion: access.workspace.version, submittedByUserId: access.principal.id,
			notes: text(body.notes) || null, commitSha: commit.commitSha, changedPaths: diff.changedPaths,
			requiredReviewerIds, ...editorial });
		if (!submitted.ok || !submitted.review) return jsonError(c, 409,
			'The draft changed while it was submitted. Reload before trying again.', { code: 'stale_workspace' });
		await store.recordAuditEvent({ id: `knowledge-review-submitted-${submitted.review.id}`,
			eventType: 'knowledge.review.submitted', actorType: 'user', actorId: access.principal.id,
			targetType: 'knowledge_review', targetId: submitted.review.id, data: { workspaceId: access.workspace.id,
				projectId: access.workspace.projectId, commitSha: commit.commitSha } });
		return c.json({ ok: true, payload: { review: submitted.review, commit } }, 201);
	});

	app.get('/v1/teams/:teamId/knowledge/reviews', async (c: any) => {
		const access = await context.requireTeamAccess(c, store, c.req.param('teamId'), 'knowledge:review');
		if (access.response) return access.response;
		const reviews = await store.listKnowledgeReviews(c.req.param('teamId'));
		const currentIds = currentReviewIds(reviews);
		return c.json({ ok: true, payload: await Promise.all(reviews.map(async (review: any) => {
			const workspace = await store.getKnowledgeWorkspace(review.workspaceId);
			const publicationAccess = workspace ? await context.requireProjectAccess(c, store, workspace.projectId, 'knowledge:publish') : null;
			const hasPublicationAuthority = Boolean(publicationAccess && !publicationAccess.response);
			const isCurrentRevision = currentIds.has(review.id);
			const workspaceAvailable = Boolean(workspace && isCurrentRevision
				&& reviewWorkspaceAvailable(review.status, workspace.status));
			return { ...review, comments: await store.listKnowledgeReviewComments(review.id),
				presence: await store.listKnowledgeWorkspacePresence(review.workspaceId),
				isCurrentRevision, workspaceAvailable,
				canDecide: Boolean(workspaceAvailable && review.status === 'open' && workspace.actorUserId !== access.principal.id),
				canApproveEditorial: Boolean(workspaceAvailable && review.status === 'open' && workspace.actorUserId !== access.principal.id
					&& hasPublicationAuthority),
				canPublish: Boolean(workspaceAvailable && review.status === 'approved' && hasPublicationAuthority) };
		})) });
	});

	app.post('/v1/knowledge/reviews/:reviewId/comments', async (c: any) => {
		const review = await store.getKnowledgeReview(c.req.param('reviewId'));
		if (!review) return jsonError(c, 404, 'Knowledge review not found.');
		const workspace = await store.getKnowledgeWorkspace(review.workspaceId);
		if (!workspace) return jsonError(c, 409, 'The review workspace is no longer available.');
		const access = await requireProjectAccess(c, store, workspace.projectId, 'knowledge:review');
		if (access.response) return access.response;
		const body = await c.req.json().catch(() => ({}));
		const message = text(body.body);
		const path = text(body.path);
		if (!message || message.length > 4_000) return jsonError(c, 422, 'Enter a review comment of 4,000 characters or fewer.',
			{ fieldErrors: { body: 'Enter a review comment.' } });
		if (!allowedWorkspacePath(workspace, path)) return jsonError(c, 422, 'Choose a changed knowledge file.',
			{ fieldErrors: { path: 'Choose a file in this review.' } });
		const connection = await resolveKnowledgeGatewayConnection(store, {
			projectId: workspace.projectId, write: false, workspaceRefs: [workspace.branchName],
		});
		if (!connection) return jsonError(c, 503, 'The review diff is unavailable.');
		const diff = await connection.client.diff({ workspaceId: workspace.treeDxWorkspaceId });
		if (!diff.changedPaths.includes(path)) return jsonError(c, 422, 'Review comments must refer to a changed file.',
			{ fieldErrors: { path: 'Choose a changed file in this review.' } });
		const created = await store.createKnowledgeReviewComment({ reviewId: review.id, authorUserId: access.principal.id,
			path, lineStart: Number(body.lineStart) || null, lineEnd: Number(body.lineEnd) || null, body: message });
		await store.recordAuditEvent({ eventType: 'knowledge.review.comment_added', actorType: 'user', actorId: access.principal.id,
			targetType: 'knowledge_review', targetId: review.id, data: { workspaceId: workspace.id,
				projectId: workspace.projectId, commentId: created.id, path } });
		return c.json({ ok: true, payload: created }, 201);
	});

	app.post('/v1/knowledge/review-comments/:commentId/resolve', async (c: any) => {
		const row = await store.first(`SELECT comments.*, reviews.workspace_id FROM knowledge_review_comments comments
			INNER JOIN knowledge_reviews reviews ON reviews.id = comments.review_id WHERE comments.id = ? LIMIT 1`,
			[c.req.param('commentId')]);
		if (!row) return jsonError(c, 404, 'Knowledge review comment not found.');
		const workspace = await store.getKnowledgeWorkspace(row.workspace_id);
		if (!workspace) return jsonError(c, 409, 'The review workspace is no longer available.');
		let access = await requireProjectAccess(c, store, workspace.projectId, 'knowledge:author');
		if (access.response || workspace.actorUserId !== access.principal.id) {
			access = await requireProjectAccess(c, store, workspace.projectId, 'knowledge:review');
		}
		if (access.response) return access.response;
		const body = await c.req.json().catch(() => ({}));
		const result = await store.resolveKnowledgeReviewComment(row.id, { version: Number(body.version), userId: access.principal.id });
		if (!result.ok) return jsonError(c, 409, 'The review comment changed. Reload before resolving it.', { code: 'stale_review_comment' });
		await store.recordAuditEvent({ eventType: 'knowledge.review.comment_resolved', actorType: 'user', actorId: access.principal.id,
			targetType: 'knowledge_review', targetId: row.review_id, data: { workspaceId: workspace.id,
				projectId: workspace.projectId, commentId: row.id, path: row.path } });
		return c.json({ ok: true, payload: result.comment });
	});

	app.post('/v1/knowledge/reviews/:reviewId/decision', async (c: any) => {
		const review = await store.getKnowledgeReview(c.req.param('reviewId'));
		if (!review) return jsonError(c, 404, 'Knowledge review not found.');
		const workspace = await store.getKnowledgeWorkspace(review.workspaceId);
		if (!workspace) return jsonError(c, 409, 'The review workspace is no longer available.');
		const access = await requireProjectAccess(c, store, workspace.projectId, 'knowledge:review');
		if (access.response) return access.response;
		const body = await c.req.json().catch(() => ({}));
		let simulationPolicy;
		try { simulationPolicy = await assertSimulatedProductionPolicy(store, workspace, body); }
		catch (error: any) { return jsonError(c, error.status ?? 403, error.message, { code: error.code }); }
		if (workspace.actorUserId === access.principal.id) return jsonError(c, 403, 'Authors cannot approve their own knowledge submission.', { code: 'knowledge_self_review_denied' });
		if (Number(body.version) !== workspace.version) return jsonError(c, 409, 'The review workspace changed. Reload before deciding.', { code: 'stale_knowledge_review' });
		const connection = await resolveKnowledgeGatewayConnection(store, {
			projectId: workspace.projectId, write: false, workspaceRefs: [workspace.branchName],
		});
		if (!connection) return jsonError(c, 503, 'The review diff is unavailable. Review decisions fail closed.');
		const diff = await connection.client.diff({ workspaceId: workspace.treeDxWorkspaceId });
		if (!reviewPathsMatch(review.changedPaths, diff.changedPaths)) return jsonError(c, 409,
			'The review diff no longer matches its submitted snapshot.', { code: 'knowledge_review_diff_changed' });
		const decision = text(body.decision);
		if (!['approve', 'request-changes'].includes(decision)) return jsonError(c, 422, 'Choose approve or request changes.', { code: 'invalid_review_decision' });
		if (decision === 'request-changes' && !text(body.notes)) return jsonError(c, 422, 'Explain the requested changes.', { fieldErrors: { notes: 'Review notes are required.' } });
		let decisionPrincipalId = access.principal.id;
		if (decision === 'approve') {
			if (review.requiresEditorialReview) {
				const bookOwnerAccess = await requireProjectAccess(c, store, workspace.projectId, 'knowledge:publish');
				if (bookOwnerAccess.response) return bookOwnerAccess.response;
				decisionPrincipalId = bookOwnerAccess.principal.id;
			}
			const gate = editorialReviewGate(review);
			if (!gate.ok) return jsonError(c, 409, 'Required editorial reviews have not approved this exact revision.', { code: gate.code });
			const openComments = await store.first(`SELECT COUNT(*) AS count FROM knowledge_review_comments
				WHERE review_id = ? AND status = 'open'`, [review.id]);
			if (Number(openComments?.count ?? 0) > 0) return jsonError(c, 409, 'Resolve every review comment before approval.',
				{ code: 'knowledge_review_comments_open' });
		}
		let revisionConnection: any = null;
		let revisionWorkspace: any = null;
		if (decision === 'request-changes') {
			revisionConnection = await resolveKnowledgeGatewayConnection(store, {
				projectId: workspace.projectId, write: true, workspaceRefs: [workspace.branchName],
			});
			if (!revisionConnection) return jsonError(c, 503, 'A writable revision workspace is unavailable. The review remains open.');
			try { revisionWorkspace = await createRevisionWorkspace(revisionConnection, workspace, review.commitSha); }
			catch { return jsonError(c, 409, 'The reviewed branch changed before a revision workspace could be created.', { code: 'knowledge_revision_branch_changed' }); }
		}
		const result = await store.decideKnowledgeReview(review.id, { decision, decidedByUserId: decisionPrincipalId,
			notes: text(body.notes) || null, workspaceId: workspace.id, workspaceVersion: workspace.version,
			revisionWorkspace });
		if (!result.ok) {
			await discardRevisionWorkspace(revisionConnection, revisionWorkspace);
			return jsonError(c, 409, 'This review was already decided.', { code: 'stale_knowledge_review' });
		}
		await store.recordAuditEvent({ eventType: decision === 'approve' ? 'knowledge.review.approved' : 'knowledge.review.changes_requested',
			actorType: 'user', actorId: decisionPrincipalId, targetType: 'knowledge_review', targetId: review.id,
			data: { workspaceId: workspace.id, projectId: workspace.projectId, commitSha: review.commitSha,
				simulation: { ...simulationPolicy.simulation, operatorPrincipalId: access.principal.id }, productionApproval: simulationPolicy.production } });
		return c.json({ ok: true, payload: result.review });
	});

	app.post('/v1/knowledge/reviews/:reviewId/publish', async (c: any) => {
		const review = await store.getKnowledgeReview(c.req.param('reviewId'));
		if (!review) return jsonError(c, 404, 'Knowledge review not found.');
		const workspace = await store.getKnowledgeWorkspace(review.workspaceId);
		if (!workspace) return jsonError(c, 409, 'The approved workspace is no longer available.');
		const access = await requireProjectAccess(c, store, workspace.projectId, 'knowledge:publish');
		if (access.response) return access.response;
		const body = await c.req.json().catch(() => ({}));
		let simulationPolicy;
		try { simulationPolicy = await assertSimulatedProductionPolicy(store, workspace, body); }
		catch (error: any) { return jsonError(c, error.status ?? 403, error.message, { code: error.code }); }
		if (simulationPolicy.production) return jsonError(c, 409,
			'Production knowledge publication remains disabled while hosted deployment is suspended.', { code: 'hosted_deployment_suspended' });
		if (review.status !== 'approved' || workspace.status !== 'approved' || !review.commitSha) {
			return jsonError(c, 409, 'Only an approved, unchanged knowledge review can be published.', { code: 'knowledge_review_not_publishable' });
		}
		const editorialGate = editorialReviewGate(review);
		if (!editorialGate.ok) return jsonError(c, 409, 'The editorial review gate is incomplete.', { code: editorialGate.code });
		const publishedRef = workspace.baseRef;
		const publication = await store.createKnowledgePublication({ workspaceId: workspace.id, reviewId: review.id,
			projectId: workspace.projectId, commitSha: review.commitSha, publishedRef });
		const operation = await store.createPlatformOperation({ namespace: 'knowledge', operation: 'publish_review',
			target: 'control_plane_operations_runner', idempotencyKey: `knowledge-publication:${publication.id}`,
			input: { publicationId: publication.id, simulation: { ...simulationPolicy.simulation, operatorPrincipalId: access.principal.id } }, requestedByType: 'user', requestedById: access.principal.id });
		return c.json({ ok: true, code: 'knowledge_publication_queued', message: 'Approved knowledge publication queued.',
			payload: { publication, operation } }, 202);
	});
}
