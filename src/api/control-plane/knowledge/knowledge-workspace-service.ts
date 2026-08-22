import { randomUUID } from 'node:crypto';
import { resolveKnowledgeGatewayConnection } from '../../knowledge/gateway-treedx-connection.ts';
import { treeDxWorkspaceId } from '../../knowledge/workspace-identity.ts';
import { applyTextChangeset } from '../../knowledge/changesets/apply-text-changeset.ts';
import { parseBook, parseKnowledgePage } from '../../knowledge/runtime/catalog.ts';
import { serializeBookDraft, serializeKnowledgePageDraft } from '../../knowledge/runtime/authoring.ts';
import { editorialSubmissionRequirements, requiredRevisionReviewerIds, verifiedEditorialContextTrace } from '../../knowledge/editorial-review.ts';
import { projectTreeDxCommitSignals } from '../../capacity/services/treedx/repositories/treedx-change-projector.ts';
import { recordTreeDxAuthoringState } from '../../capacity/services/treedx/repositories/treedx-authoring-journal.ts';
import { KnowledgeOperationError } from './knowledge-operation-error.ts';

type Principal = { id: string; roles?: string[]; permissions?: string[] } | undefined;

export function createKnowledgeWorkspaceService(store: any, reader: { projectCatalog(principal: Principal, projectId: string): Promise<Record<string, any>> }) {
	async function projectAccess(principal: Principal, projectId: string, permission: string) {
		if (!principal) throw new KnowledgeOperationError(401, 'authentication_required', 'Authentication is required.');
		const details = await store.getProjectDetails(projectId);
		if (!details?.project) throw new KnowledgeOperationError(404, 'project_not_found', 'The project was not found.');
		const administrator = principal.roles?.some((role) => ['admin', 'platform_admin'].includes(role))
			|| principal.permissions?.includes('*:*:*');
		if (!administrator && !await store.principalCanAccessTeam(principal, details.project.teamId)) {
			throw new KnowledgeOperationError(403, 'knowledge_access_denied', 'The principal cannot access this project.');
		}
		const access = administrator ? { permissions: ['*:*:*'] } : await store.getTeamAccessSummary(details.project.teamId, principal);
		if (!administrator && !access.permissions.includes(permission)) {
			throw new KnowledgeOperationError(403, 'knowledge_permission_denied', `${permission} authority is required.`);
		}
		return { principal, project: details.project };
	}

	async function workspaceAccess(principal: Principal, workspaceId: string, permission: string) {
		const workspace = await store.getKnowledgeWorkspace(workspaceId);
		if (!workspace) throw new KnowledgeOperationError(404, 'knowledge_workspace_not_found', 'Knowledge workspace not found.');
		let access;
		try { access = await projectAccess(principal, workspace.projectId, permission); }
		catch (error) {
			if (permission === 'knowledge:read') {
				try { access = await projectAccess(principal, workspace.projectId, 'knowledge:review'); }
				catch { throw new KnowledgeOperationError(404, 'knowledge_workspace_not_found', 'Knowledge workspace not found.'); }
			} else throw error;
		}
		if (permission === 'knowledge:read' && workspace.actorUserId !== access.principal.id) {
			await projectAccess(principal, workspace.projectId, 'knowledge:review');
		}
		return { ...access, workspace };
	}

	return {
		async create(principal: Principal, projectId: string, input: Record<string, unknown>) {
			const access = await projectAccess(principal, projectId, 'knowledge:author');
			const supplied = typeof input.requestId === 'string' ? input.requestId.trim() : '';
			const id = supplied || randomUUID();
			if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
				throw new KnowledgeOperationError(422, 'knowledge_request_id_invalid', 'A valid authoring request identifier is required.');
			}
			const existing = await store.getKnowledgeWorkspace(id);
			if (existing) {
				if (existing.projectId !== projectId || existing.actorUserId !== access.principal.id) {
					throw new KnowledgeOperationError(409, 'knowledge_request_id_conflict', 'This authoring request identifier is already in use.');
				}
				return existing;
			}
			const branchName = `refs/heads/knowledge/${id}`;
			const connection = await resolveKnowledgeGatewayConnection(store, { projectId, write: true, workspaceRefs: [branchName] });
			if (!connection) throw new KnowledgeOperationError(503, 'knowledge_repository_unavailable', 'The project knowledge repository is unavailable.');
			let remote;
			try {
				remote = await connection.client.createWorkspace({ workspaceId: treeDxWorkspaceId(id), repoId: connection.repositoryId,
					baseRef: connection.baseRef, branchName, mode: 'writable', allowedPaths: connection.allowedPaths, ttlSeconds: 86_400 });
			} catch { throw new KnowledgeOperationError(503, 'knowledge_workspace_unavailable', 'The project knowledge workspace could not be created.'); }
			const workspace = await store.createKnowledgeWorkspaceRecord({ id, teamId: access.project.teamId, projectId,
				repositoryId: connection.repositoryId, treeDxWorkspaceId: remote.workspaceId, actorUserId: access.principal.id,
				baseRef: remote.baseRef, baseCommitSha: remote.baseCommitSha, branchName: remote.branchName ?? branchName,
				allowedPaths: connection.allowedPaths });
			await store.recordAuditEvent({ id: `knowledge-workspace-created-${workspace.id}`, eventType: 'knowledge.workspace.created',
				actorType: 'user', actorId: access.principal.id, targetType: 'knowledge_workspace', targetId: workspace.id,
				data: { teamId: workspace.teamId, projectId, repositoryId: workspace.repositoryId } });
			return workspace;
		},

		async show(principal: Principal, workspaceId: string) {
			const access = await workspaceAccess(principal, workspaceId, 'knowledge:read');
			return { ...access.workspace, presence: await store.listKnowledgeWorkspacePresence(workspaceId) };
		},

		async readContent(principal: Principal, workspaceId: string, pathValue: unknown) {
			const access = await workspaceAccess(principal, workspaceId, 'knowledge:read');
			const path = text(pathValue);
			if (!allowedPath(access.workspace, path)) throw new KnowledgeOperationError(422, 'knowledge_path_invalid', 'Choose a knowledge file in this project workspace.');
			const connection = await resolveKnowledgeGatewayConnection(store, { projectId: access.workspace.projectId,
				write: false, workspaceRefs: [access.workspace.branchName] });
			if (!connection) throw new KnowledgeOperationError(503, 'knowledge_repository_unavailable', 'The project knowledge repository is unavailable.');
			const file = await connection.client.readFile({ workspaceId: access.workspace.treeDxWorkspaceId, path });
			try {
				const isBook = path.startsWith(`${connection.contentPath}/books/`);
				const definition = isBook ? parseBook({ path, raw: file.content }) : parseKnowledgePage({ path, raw: file.content });
				const catalog = isBook ? { pages: [] } : await reader.projectCatalog(access.principal, access.workspace.projectId);
				const backlinks = isBook ? [] : (catalog.pages ?? []).filter((page: any) => page.relatedKnowledgeIds?.includes((definition as any).id))
					.map((page: any) => ({ id: page.id, title: page.title, summary: page.summary, canonicalPath: canonicalPath(page) }));
				return { kind: isBook ? 'book' : 'page', path, expectedSha: file.sha, definition, backlinks };
			} catch (error) {
				if (error instanceof KnowledgeOperationError) throw error;
				throw new KnowledgeOperationError(422, 'knowledge_content_invalid', error instanceof Error ? error.message : 'The knowledge file is invalid.');
			}
		},

		async updateContent(principal: Principal, workspaceId: string, input: Record<string, unknown>) {
			const access = await workspaceAccess(principal, workspaceId, 'knowledge:author');
			if (access.workspace.actorUserId !== access.principal.id) throw new KnowledgeOperationError(403, 'knowledge_workspace_author_required', 'Only the workspace author can edit this draft.');
			if (!['draft', 'changes-requested'].includes(access.workspace.status)) throw new KnowledgeOperationError(409, 'knowledge_workspace_locked', 'This draft is locked while it is in review or publication.');
			if (Number(input.version) !== access.workspace.version) throw new KnowledgeOperationError(409, 'stale_workspace', 'The draft changed. Reload before saving.');
			const connection = await resolveKnowledgeGatewayConnection(store, { projectId: access.workspace.projectId,
				write: true, workspaceRefs: [access.workspace.branchName] });
			if (!connection) throw new KnowledgeOperationError(503, 'knowledge_repository_unavailable', 'The project knowledge repository is unavailable.');
			const sourcePath = text(input.sourcePath);
			let before: string | null = null, status: 'published' | 'archived' = 'published';
			if (sourcePath) {
				const current = await connection.client.readFile({ workspaceId: access.workspace.treeDxWorkspaceId, path: sourcePath });
				before = current.content;
				const currentDefinition = input.kind === 'book' ? parseBook({ path: sourcePath, raw: current.content })
					: parseKnowledgePage({ path: sourcePath, raw: current.content });
				status = currentDefinition.status === 'archived' ? 'archived' : 'published';
			}
			let content;
			try { content = input.kind === 'book' ? bookDocument(input, status) : pageDocument(input, status); }
			catch (error) { throw new KnowledgeOperationError(422, 'invalid_knowledge_content', error instanceof Error ? error.message : 'Invalid knowledge content.'); }
			const slug = text(input.slug);
			const derivedPath = input.kind === 'book' ? `${connection.contentPath}/books/${slug}.md`
				: `${connection.contentPath}/knowledge/${text(input.bookId)}/${slug}.md`;
			const path = sourcePath || derivedPath;
			if (!allowedPath(access.workspace, path)) throw new KnowledgeOperationError(422, 'knowledge_path_invalid', 'The knowledge path is outside this workspace.');
			if (sourcePath && path !== derivedPath) throw new KnowledgeOperationError(422, 'knowledge_path_move_required', 'Changing a knowledge path requires an explicit move operation.');
			const result = await applyTextChangeset({ client: connection.client, workspace: { workspaceId: access.workspace.treeDxWorkspaceId,
				baseCommitSha: access.workspace.baseCommitSha, baseRef: access.workspace.baseRef }, changes: [{ path, before, after: content }],
				idempotencyKey: `knowledge-content-${workspaceId}-${access.workspace.version}` });
			const updated = await store.updateKnowledgeWorkspace(workspaceId, { version: access.workspace.version, status: 'draft' });
			if (!updated.ok) throw new KnowledgeOperationError(409, 'stale_workspace', 'The draft changed. Reload before saving.');
			await store.recordAuditEvent({ eventType: input.kind === 'book' ? 'knowledge.book.updated' : 'knowledge.page.updated',
				actorType: 'user', actorId: access.principal.id, targetType: input.kind === 'book' ? 'book' : 'knowledge_page',
				targetId: text(input.id), data: { workspaceId, projectId: access.workspace.projectId, path } });
			return { result, workspace: updated.workspace };
		},

		async submit(principal: Principal, workspaceId: string, input: Record<string, unknown>) {
			const access = await workspaceAccess(principal, workspaceId, 'knowledge:author');
			if (access.workspace.actorUserId !== access.principal.id) throw new KnowledgeOperationError(403, 'knowledge_workspace_author_required', 'Only the workspace author can submit this draft.');
			const existingReview = await store.getKnowledgeReviewByWorkspace(workspaceId);
			if (access.workspace.status === 'submitted' && existingReview) {
				return { review: existingReview, commit: { commitSha: existingReview.commitSha, branchName: access.workspace.branchName,
					changedPaths: existingReview.changedPaths, status: 'committed' }, replayed: true };
			}
			if (!['draft', 'changes-requested'].includes(access.workspace.status)) throw new KnowledgeOperationError(409, 'knowledge_workspace_locked', 'This workspace has already been submitted.');
			if (Number(input.version) !== access.workspace.version) throw new KnowledgeOperationError(409, 'stale_workspace', 'The draft changed. Reload before submitting.');
			const connection = await resolveKnowledgeGatewayConnection(store, { projectId: access.workspace.projectId,
				write: true, workspaceRefs: [access.workspace.branchName] });
			if (!connection) throw new KnowledgeOperationError(503, 'knowledge_repository_unavailable', 'The project knowledge repository is unavailable.');
			const diff = await connection.client.diff({ workspaceId: access.workspace.treeDxWorkspaceId });
			if (!diff.changedPaths.length) throw new KnowledgeOperationError(422, 'empty_knowledge_draft', 'The draft has no changes.');
			const editorial = editorialSubmissionRequirements(diff.changedPaths, input.contextDigest);
			if (editorial.error) throw new KnowledgeOperationError(422, 'editorial_context_required', editorial.error);
			if (editorial.requiresEditorialReview && !await verifiedEditorialContextTrace(store, access.workspace.projectId, editorial.contextDigest)) {
				throw new KnowledgeOperationError(409, 'editorial_context_trace_required', 'The editorial context digest is not backed by a successful Guide authoring trace for this project.');
			}
			const remoteStatus = await connection.client.status({ workspaceId: access.workspace.treeDxWorkspaceId });
			const commit = remoteStatus.status === 'committed' && remoteStatus.commitSha
				? { repoId: access.workspace.repositoryId, workspaceId: access.workspace.treeDxWorkspaceId,
					branchName: remoteStatus.branchName ?? access.workspace.branchName, commitSha: remoteStatus.commitSha,
					changedPaths: diff.changedPaths, status: 'committed' as const }
				: await connection.client.commit({ workspaceId: access.workspace.treeDxWorkspaceId,
					message: text(input.message) || 'Update knowledge', author: { name: access.principal.id,
						email: `${access.principal.id}@users.treeseed.local` } });
			await recordTreeDxAuthoringState(store, 'unpublished', { projectId: access.workspace.projectId,
				repositoryId: access.workspace.repositoryId, commitSha: commit.commitSha, ref: commit.branchName,
				changedPaths: diff.changedPaths, actorType: 'user', actorId: access.principal.id });
			await projectTreeDxCommitSignals(store, { projectId: access.workspace.projectId, commitSha: commit.commitSha,
				immutableRef: commit.branchName, changedPaths: diff.changedPaths, changeSummary: text(input.message) || 'Update knowledge',
				actorType: 'user', actorId: access.principal.id });
			const submitted = await store.submitKnowledgeWorkspace({ workspaceId, workspaceVersion: access.workspace.version,
				submittedByUserId: access.principal.id, notes: text(input.notes) || null, commitSha: commit.commitSha,
				changedPaths: diff.changedPaths, requiredReviewerIds: requiredRevisionReviewerIds(existingReview), ...editorial });
			if (!submitted.ok || !submitted.review) throw new KnowledgeOperationError(409, 'stale_workspace', 'The draft changed while it was submitted. Reload before trying again.');
			await store.recordAuditEvent({ id: `knowledge-review-submitted-${submitted.review.id}`, eventType: 'knowledge.review.submitted',
				actorType: 'user', actorId: access.principal.id, targetType: 'knowledge_review', targetId: submitted.review.id,
				data: { workspaceId, projectId: access.workspace.projectId, commitSha: commit.commitSha } });
			return { review: submitted.review, commit, replayed: false };
		},

		async diff(principal: Principal, workspaceId: string) {
			const access = await workspaceAccess(principal, workspaceId, 'knowledge:read');
			const connection = await resolveKnowledgeGatewayConnection(store, { projectId: access.workspace.projectId,
				write: false, workspaceRefs: [access.workspace.branchName] });
			if (!connection) throw new KnowledgeOperationError(503, 'knowledge_repository_unavailable', 'The project knowledge repository is unavailable.');
			return connection.client.diff({ workspaceId: access.workspace.treeDxWorkspaceId });
		},

		async abandon(principal: Principal, workspaceId: string, input: Record<string, unknown>) {
			const access = await workspaceAccess(principal, workspaceId, 'knowledge:author');
			if (access.workspace.actorUserId !== access.principal.id) throw new KnowledgeOperationError(403, 'knowledge_workspace_author_required', 'Only the workspace author can abandon this draft.');
			if (!['draft', 'changes-requested'].includes(access.workspace.status)) throw new KnowledgeOperationError(409, 'knowledge_workspace_locked', 'A submitted or published workspace cannot be abandoned.');
			if (Number(input.version) !== access.workspace.version) throw new KnowledgeOperationError(409, 'stale_workspace', 'The draft changed. Reload before abandoning it.');
			const connection = await resolveKnowledgeGatewayConnection(store, { projectId: access.workspace.projectId,
				write: true, workspaceRefs: [access.workspace.branchName] });
			if (!connection) throw new KnowledgeOperationError(503, 'knowledge_repository_unavailable', 'The project knowledge repository is unavailable.');
			await connection.client.closeWorkspace(access.workspace.treeDxWorkspaceId);
			const updated = await store.updateKnowledgeWorkspace(workspaceId, { version: access.workspace.version, status: 'abandoned' });
			if (!updated.ok) throw new KnowledgeOperationError(409, 'stale_workspace', 'The draft changed. Reload before abandoning it.');
			await store.recordAuditEvent({ eventType: 'knowledge.workspace.abandoned', actorType: 'user', actorId: access.principal.id,
				targetType: 'knowledge_workspace', targetId: workspaceId, data: { projectId: access.workspace.projectId } });
			return updated.workspace;
		},
	};
}

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const list = (value: unknown) => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []).map(String).map((item) => item.trim()).filter(Boolean);

function allowedPath(workspace: any, path: string) {
	return Boolean(path && !path.startsWith('/') && !path.split('/').some((part) => !part || part === '.' || part === '..')
		&& workspace.allowedPaths.some((pattern: string) => path.startsWith(pattern.replace(/\*\*$/u, ''))));
}

function canonicalPath(page: any) {
	return `/t/${encodeURIComponent(page.source.teamSlug)}/books/${encodeURIComponent(page.source.bookSlug ?? page.bookId)}/${page.slug.split('/').map(encodeURIComponent).join('/')}`;
}

function pageDocument(body: Record<string, unknown>, status: 'published' | 'archived') {
	return serializeKnowledgePageDraft({ id: text(body.id), bookId: text(body.bookId), slug: text(body.slug), title: text(body.title),
		summary: text(body.summary), status, visibility: body.visibility ?? 'team', order: Number(body.order ?? 0),
		parentId: text(body.parentId) || undefined, tags: list(body.tags), contributors: list(body.contributors),
		relatedBookIds: list(body.relatedBookIds), relatedKnowledgeIds: list(body.relatedKnowledgeIds), relatedNoteIds: list(body.relatedNoteIds),
		relatedQuestionIds: list(body.relatedQuestionIds), relatedObjectiveIds: list(body.relatedObjectiveIds),
		relatedProposalIds: list(body.relatedProposalIds), relatedDecisionIds: list(body.relatedDecisionIds), guaranteeIds: list(body.guaranteeIds),
		audiences: body.audiences ?? { primary: [], secondary: [], excluded: [] }, context: { capabilityIds: list(body.capabilityIds),
			routePatterns: list(body.routePatterns), resourceTypes: list(body.resourceTypes), actionIds: list(body.actionIds),
			keywords: list(body.keywords), documentationUrls: list(body.documentationUrls) }, bodyMarkdown: String(body.bodyMarkdown ?? '') });
}

function bookDocument(body: Record<string, unknown>, status: 'published' | 'archived') {
	return serializeBookDraft({ id: text(body.id), slug: text(body.slug), title: text(body.title), summary: text(body.summary),
		description: text(body.description) || text(body.summary), status, visibility: body.visibility ?? 'team', order: Number(body.order ?? 0),
		topics: list(body.topics), audience: list(body.audience), relatedBookIds: list(body.relatedBookIds),
		editorialCoreNoteId: text(body.editorialCoreNoteId) || undefined, packPolicy: body.packPolicy ?? 'allowed',
		cover: body.cover && typeof body.cover === 'object' ? body.cover : undefined });
}
