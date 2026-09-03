import { randomUUID } from 'node:crypto';
import { projectLibraryPath, resolveKnowledgeGatewayConnection } from '../../knowledge/gateway-treedx-connection.ts';
import { treeDxWorkspaceId } from '../../knowledge/workspaces/identity.ts';
import { applyTextChangeset } from '../../knowledge/changesets/apply-text-changeset.ts';
import { parseBook, parseKnowledgePage } from '../../knowledge/runtime/catalog.ts';
import { requireKnowledgePageBookPath } from '../../knowledge/snapshot-projects.ts';
import { serializeBookDraft, serializeKnowledgePageDraft } from '../../knowledge/runtime/authoring.ts';
import { projectTreeDxCommitSignals } from '../../capacity/services/treedx/repositories/treedx-change-projector.ts';
import { recordTreeDxAuthoringState } from '../../capacity/services/treedx/repositories/treedx-authoring-journal.ts';
import { KnowledgeOperationError } from './knowledge-operation-error.ts';
import { createKnowledgeAuthorization, type KnowledgePrincipal } from './knowledge-authorization.ts';
import { allowedKnowledgePath } from './knowledge-path.ts';
import { AGENT_OPERATIONAL_CONTENT_COLLECTIONS,validateContentFrontmatter } from '@treeseed/sdk/content-validation';
import { compileDeclarativeContextQuery } from '@treeseed/sdk/graph/context-query-contracts';
import { parseFrontmatterDocument } from '../../content/frontmatter.ts';
import { validateAgentDefinitionSource } from '../repositories/agents/agent-definition-source.ts';

const operationalModels=new Map([...Object.entries(AGENT_OPERATIONAL_CONTENT_COLLECTIONS).map(([model,collection])=>[collection,model] as const),['agent-tests','agent_test']]);
function operationalModel(path:string){const collection=path.split('/').at(-2)??path.split('/')[0]??'';return operationalModels.get(collection)??operationalModels.get(path.split('/')[0]??'')??null;}

export function createKnowledgeWorkspaceService(store: any, reader: { projectCatalog(principal: KnowledgePrincipal, projectId: string): Promise<Record<string, any>> }) {
	const authorization = createKnowledgeAuthorization(store);
	async function workspaceAccess(principal: KnowledgePrincipal, workspaceId: string, permission: string) {
		const workspace = await store.getKnowledgeWorkspace(workspaceId);
		if (!workspace) throw new KnowledgeOperationError(404, 'knowledge_workspace_not_found', 'Knowledge workspace not found.');
		let access;
		try { access = await authorization.project(principal, workspace.projectId, permission); }
		catch (error) {
			if (permission === 'knowledge:read') {
				try { access = await authorization.project(principal, workspace.projectId, 'knowledge:review'); }
				catch { throw new KnowledgeOperationError(404, 'knowledge_workspace_not_found', 'Knowledge workspace not found.'); }
			} else throw error;
		}
		if (permission === 'knowledge:read' && workspace.actorUserId !== access.principal.id) {
			await authorization.project(principal, workspace.projectId, 'knowledge:review');
		}
		return { ...access, workspace };
	}

	return {
		async create(principal: KnowledgePrincipal, projectId: string, input: Record<string, unknown>) {
			const access = await authorization.project(principal, projectId, 'knowledge:author');
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
			const connection = await resolveKnowledgeGatewayConnection(store, { projectId, write: true, workspaceRefs: [branchName], authoringPaths: true });
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

		async show(principal: KnowledgePrincipal, workspaceId: string) {
			const access = await workspaceAccess(principal, workspaceId, 'knowledge:read');
			return { ...access.workspace, presence: await store.listKnowledgeWorkspacePresence(workspaceId) };
		},

		async readContent(principal: KnowledgePrincipal, workspaceId: string, pathValue: unknown) {
			const access = await workspaceAccess(principal, workspaceId, 'knowledge:read');
			const path = text(pathValue);
			if (!allowedKnowledgePath(access.workspace, path)) throw new KnowledgeOperationError(422, 'knowledge_path_invalid', 'Choose a knowledge file in this project workspace.');
			const connection = await resolveKnowledgeGatewayConnection(store, { projectId: access.workspace.projectId,
				write: false, workspaceRefs: [access.workspace.branchName], authoringPaths: true });
			if (!connection) throw new KnowledgeOperationError(503, 'knowledge_repository_unavailable', 'The project knowledge repository is unavailable.');
			const file = await connection.client.readFile({ workspaceId: access.workspace.treeDxWorkspaceId, path });
			const model = operationalModel(path);
			if (model) {
				// Operational collections have their own current schemas. Return the
				// exact source so an invalid historical definition can be migrated
				// through the governed workspace instead of being compatibility-read
				// as a knowledge page.
				return { kind: 'operational-content', model, path, expectedSha: file.sha, content: file.content };
			}
			if (path.startsWith(projectLibraryPath(connection.contentPath, 'agents') + '/')) {
				return { kind: 'agent-profile', path, expectedSha: file.sha, content: file.content };
			}
			try {
				const isBook = path.startsWith(`${projectLibraryPath(connection.contentPath, 'books')}/`);
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

		async updateContent(principal: KnowledgePrincipal, workspaceId: string, input: Record<string, unknown>) {
			const access = await workspaceAccess(principal, workspaceId, 'knowledge:author');
			if (access.workspace.actorUserId !== access.principal.id) throw new KnowledgeOperationError(403, 'knowledge_workspace_author_required', 'Only the workspace author can edit this draft.');
			if (!['draft', 'changes-requested'].includes(access.workspace.status)) throw new KnowledgeOperationError(409, 'knowledge_workspace_locked', 'This draft is locked while it is in review or publication.');
			if (Number(input.version) !== access.workspace.version) throw new KnowledgeOperationError(409, 'stale_workspace', 'The draft changed. Reload before saving.');
			const connection = await resolveKnowledgeGatewayConnection(store, { projectId: access.workspace.projectId,
				write: true, workspaceRefs: [access.workspace.branchName], authoringPaths: true });
			if (!connection) throw new KnowledgeOperationError(503, 'knowledge_repository_unavailable', 'The project knowledge repository is unavailable.');
			const sourcePath = text(input.sourcePath);
			if(input.delete===true) {
				if(!sourcePath||!allowedKnowledgePath(access.workspace,sourcePath))throw new KnowledgeOperationError(422,'knowledge_path_invalid','Choose an existing knowledge file in this project workspace.');
				const current=await connection.client.readFile({workspaceId:access.workspace.treeDxWorkspaceId,path:sourcePath});
				if(!text(input.expectedSha)||text(input.expectedSha)!==current.sha)throw new KnowledgeOperationError(409,'stale_workspace_file','The knowledge file changed. Reload before deleting it.');
				const result=await connection.client.deleteFile({workspaceId:access.workspace.treeDxWorkspaceId,path:sourcePath});
				const updated=await store.updateKnowledgeWorkspace(workspaceId,{version:access.workspace.version,status:'draft'});if(!updated.ok)throw new KnowledgeOperationError(409,'stale_workspace','The draft changed. Reload before deleting the file.');
				await store.recordAuditEvent({eventType:'knowledge.content.deleted',actorType:principalType(access.principal.id),actorId:access.principal.id,targetType:'knowledge_content',targetId:sourcePath,data:{workspaceId,projectId:access.workspace.projectId,path:sourcePath}});
				return {result,workspace:updated.workspace};
			}
			if(input.kind==='operational-content') {
				const model=operationalModel(sourcePath);if(!model)throw new KnowledgeOperationError(422,'operational_content_path_invalid','Choose a registered operational-content collection.');
				if(!allowedKnowledgePath(access.workspace,sourcePath))throw new KnowledgeOperationError(422,'knowledge_path_invalid','The operational content path is outside this workspace.');
				const content=typeof input.content==='string'?input.content:'';if(!content.trim())throw new KnowledgeOperationError(422,'operational_content_required','Operational content is required.');
				const validation=validateContentFrontmatter(model as never,parseFrontmatterDocument(content).frontmatter);if(!validation.ok)throw new KnowledgeOperationError(422,'operational_content_invalid',`The ${model} content is invalid: ${validation.diagnostics.map((entry)=>entry.message).join(' ')}`);
				if(model==='agent_context_query') {
					const compiled=compileDeclarativeContextQuery(validation.data as never);
					if(!compiled.ok)throw new KnowledgeOperationError(422,'context_query_compile_invalid',compiled.errors.join(' '));
				}
				let before:null|string=null;if(input.create!==true){const current=await connection.client.readFile({workspaceId:access.workspace.treeDxWorkspaceId,path:sourcePath});if(!text(input.expectedSha)||text(input.expectedSha)!==current.sha)throw new KnowledgeOperationError(409,'stale_workspace_file','The operational content changed. Reload before saving.');before=current.content;}
				const result=await applyTextChangeset({client:connection.client,workspace:{workspaceId:access.workspace.treeDxWorkspaceId,baseCommitSha:access.workspace.baseCommitSha,baseRef:access.workspace.baseRef},changes:[{path:sourcePath,before,after:content}],idempotencyKey:`operational-content-${workspaceId}-${access.workspace.version}`});
				const updated=await store.updateKnowledgeWorkspace(workspaceId,{version:access.workspace.version,status:'draft'});if(!updated.ok)throw new KnowledgeOperationError(409,'stale_workspace','The draft changed. Reload before saving.');
				await store.recordAuditEvent({eventType:'knowledge.operational_content.updated',actorType:'user',actorId:access.principal.id,targetType:model,targetId:sourcePath,data:{workspaceId,projectId:access.workspace.projectId,path:sourcePath}});
				return {result,workspace:updated.workspace};
			}
			if (input.kind === 'agent-profile') {
				if (!sourcePath.startsWith(projectLibraryPath(connection.contentPath, 'agents') + '/')) throw new KnowledgeOperationError(422, 'agent_profile_path_invalid', 'Agent profiles must remain in the agents collection.');
				if (!allowedKnowledgePath(access.workspace, sourcePath)) throw new KnowledgeOperationError(422, 'knowledge_path_invalid', 'The agent profile path is outside this workspace.');
				let before: string | null = null;
				if (input.create !== true) {
					const current = await connection.client.readFile({ workspaceId: access.workspace.treeDxWorkspaceId, path: sourcePath });
					if (!text(input.expectedSha) || text(input.expectedSha) !== current.sha) throw new KnowledgeOperationError(409, 'stale_workspace_file', 'The agent profile changed. Reload before saving.');
					before = current.content;
				}
				const content = typeof input.content === 'string' ? input.content : '';
				if (!content.trim()) throw new KnowledgeOperationError(422, 'agent_profile_content_required', 'Agent profile content is required.');
				const validation=validateAgentDefinitionSource(content);
				if(!validation.ok)throw new KnowledgeOperationError(422,'agent_profile_invalid',`The agent profile is invalid: ${validation.diagnostics.map((entry)=>`${entry.path}: ${entry.message}`).join('; ')}`);
				const result = await applyTextChangeset({ client: connection.client, workspace: { workspaceId: access.workspace.treeDxWorkspaceId,
					baseCommitSha: access.workspace.baseCommitSha, baseRef: access.workspace.baseRef }, changes: [{ path: sourcePath, before, after: content }],
					idempotencyKey: `agent-profile-${workspaceId}-${access.workspace.version}` });
				const updated = await store.updateKnowledgeWorkspace(workspaceId, { version: access.workspace.version, status: 'draft' });
				if (!updated.ok) throw new KnowledgeOperationError(409, 'stale_workspace', 'The draft changed. Reload before saving.');
				await store.recordAuditEvent({ eventType: 'agent.profile.updated', actorType: 'user', actorId: access.principal.id,
					targetType: 'agent_profile', targetId: sourcePath, data: { workspaceId, projectId: access.workspace.projectId, path: sourcePath } });
				return { result, workspace: updated.workspace };
			}
			let before: string | null = null, status: 'published' | 'archived' = 'published';
			if (sourcePath) {
				const current = await connection.client.readFile({ workspaceId: access.workspace.treeDxWorkspaceId, path: sourcePath });
				before = current.content;
				try {
					const currentDefinition = input.kind === 'book' ? parseBook({ path: sourcePath, raw: current.content })
						: parseKnowledgePage({ path: sourcePath, raw: current.content });
					status = currentDefinition.status === 'archived' ? 'archived' : 'published';
				} catch {
					// Invalid historical documents may only be replaced by a complete draft
					// that passes the current serializer below. No compatibility projection
					// is retained in the read or publication paths.
					status = 'published';
				}
			}
			let content;
			try { content = input.kind === 'book' ? bookDocument(input, status) : pageDocument(input, status); }
			catch (error) { throw new KnowledgeOperationError(422, 'invalid_knowledge_content', error instanceof Error ? error.message : 'Invalid knowledge content.'); }
			const slug = text(input.slug);
			const derivedPath = input.kind === 'book' ? projectLibraryPath(connection.contentPath, 'books', `${slug}.md`)
				: projectLibraryPath(connection.contentPath, 'knowledge', text(input.bookId), `${slug}.md`);
			const move = Boolean(sourcePath && sourcePath !== derivedPath && input.move === true);
			const path = move ? derivedPath : sourcePath || derivedPath;
			if (!allowedKnowledgePath(access.workspace, path)) throw new KnowledgeOperationError(422, 'knowledge_path_invalid', 'The knowledge path is outside this workspace.');
			if (sourcePath && sourcePath !== derivedPath && !move) throw new KnowledgeOperationError(422, 'knowledge_path_move_required', 'Changing a knowledge path requires an explicit move operation.');
			const result = await applyTextChangeset({ client: connection.client, workspace: { workspaceId: access.workspace.treeDxWorkspaceId,
				baseCommitSha: access.workspace.baseCommitSha, baseRef: access.workspace.baseRef }, changes: move
					? [{ path: sourcePath, before, after: null }, { path, before: null, after: content }]
					: [{ path, before, after: content }],
				idempotencyKey: `knowledge-content-${workspaceId}-${access.workspace.version}` });
			const updated = await store.updateKnowledgeWorkspace(workspaceId, { version: access.workspace.version, status: 'draft' });
			if (!updated.ok) throw new KnowledgeOperationError(409, 'stale_workspace', 'The draft changed. Reload before saving.');
			await store.recordAuditEvent({ eventType: input.kind === 'book' ? 'knowledge.book.updated' : 'knowledge.page.updated',
				actorType: 'user', actorId: access.principal.id, targetType: input.kind === 'book' ? 'book' : 'knowledge_page',
				targetId: text(input.id), data: { workspaceId, projectId: access.workspace.projectId, path } });
			return { result, workspace: updated.workspace };
		},

		async submit(principal: KnowledgePrincipal, workspaceId: string, input: Record<string, unknown>) {
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
				write: true, workspaceRefs: [access.workspace.branchName], authoringPaths: true });
			if (!connection) throw new KnowledgeOperationError(503, 'knowledge_repository_unavailable', 'The project knowledge repository is unavailable.');
			const diff = await connection.client.diff({ workspaceId: access.workspace.treeDxWorkspaceId });
			if (!diff.changedPaths.length) throw new KnowledgeOperationError(422, 'empty_knowledge_draft', 'The draft has no changes.');
			const remoteStatus = await connection.client.status({ workspaceId: access.workspace.treeDxWorkspaceId });
			const deletedPaths=new Set((remoteStatus.changes??[]).filter((change:any)=>change.status==='deleted').map((change:any)=>String(change.path)));
			const pageRoot=`${projectLibraryPath(connection.contentPath,'knowledge')}/`;
			for(const changedPath of diff.changedPaths.filter((path:string)=>path.startsWith(pageRoot))) {
				if(deletedPaths.has(changedPath))continue;
				let file;
				try { file=await connection.client.readFile({workspaceId:access.workspace.treeDxWorkspaceId,path:changedPath}); }
				catch { continue; } // A move or deletion has no remaining document to validate.
				try {
					const page=parseKnowledgePage({path:changedPath,raw:file.content});
					requireKnowledgePageBookPath(changedPath,pageRoot,page);
				} catch(error) {
					throw new KnowledgeOperationError(422,'knowledge_page_book_path_required',error instanceof Error?error.message:'Every knowledge document must be a valid page inside its declared book.');
				}
			}
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
				changedPaths: diff.changedPaths, requiredReviewerIds: {},
				requiresEditorialReview: false, contextDigest: '' });
			if (!submitted.ok || !submitted.review) throw new KnowledgeOperationError(409, 'stale_workspace', 'The draft changed while it was submitted. Reload before trying again.');
			const admittedChange = await store.decideKnowledgeReview(submitted.review.id, { decision: 'approve',
				decidedByUserId: access.principal.id, notes: text(input.notes) || null, workspaceId,
				workspaceVersion: submitted.workspace.version });
			if (!admittedChange.ok || !admittedChange.review) throw new KnowledgeOperationError(409, 'stale_workspace', 'The admitted content change became stale.');
			const publication = await store.createKnowledgePublication({ workspaceId, reviewId: admittedChange.review.id,
				projectId: access.workspace.projectId, commitSha: commit.commitSha, publishedRef: connection.publicationRef });
			const operation = await store.createPlatformOperation({ namespace: 'knowledge', operation: 'publish_review',
				target: 'control_plane_operations_runner', idempotencyKey: `knowledge-publication:${publication.id}`,
				input: { publicationId: publication.id, targetEnvironment: 'staging',
					simulation: { productionAuthorityRequested: false, operatorPrincipalId: access.principal.id } },
				requestedByType: principalType(access.principal.id), requestedById: access.principal.id });
			await store.recordAuditEvent({ id: `knowledge-content-integration-requested-${admittedChange.review.id}`,
				eventType: 'knowledge.content.integration_requested',
				actorType: principalType(access.principal.id), actorId: access.principal.id, targetType: 'knowledge_change', targetId: submitted.review.id,
				data: { workspaceId, projectId: access.workspace.projectId, commitSha: commit.commitSha,
					changedPaths: diff.changedPaths, publicationId: publication.id, operationId: operation.id } });
			return { change: admittedChange.review, review: admittedChange.review,
				integration: { publication, operation, targetEnvironment: 'staging' }, commit, replayed: false };
		},

		async diff(principal: KnowledgePrincipal, workspaceId: string) {
			const access = await workspaceAccess(principal, workspaceId, 'knowledge:read');
			const connection = await resolveKnowledgeGatewayConnection(store, { projectId: access.workspace.projectId,
				write: false, workspaceRefs: [access.workspace.branchName], authoringPaths: true });
			if (!connection) throw new KnowledgeOperationError(503, 'knowledge_repository_unavailable', 'The project knowledge repository is unavailable.');
			return connection.client.diff({ workspaceId: access.workspace.treeDxWorkspaceId });
		},

		async abandon(principal: KnowledgePrincipal, workspaceId: string, input: Record<string, unknown>) {
			const access = await workspaceAccess(principal, workspaceId, 'knowledge:author');
			if (access.workspace.actorUserId !== access.principal.id) throw new KnowledgeOperationError(403, 'knowledge_workspace_author_required', 'Only the workspace author can abandon this draft.');
			if (!['draft', 'changes-requested'].includes(access.workspace.status)) throw new KnowledgeOperationError(409, 'knowledge_workspace_locked', 'A submitted or published workspace cannot be abandoned.');
			if (Number(input.version) !== access.workspace.version) throw new KnowledgeOperationError(409, 'stale_workspace', 'The draft changed. Reload before abandoning it.');
			const connection = await resolveKnowledgeGatewayConnection(store, { projectId: access.workspace.projectId,
				write: true, workspaceRefs: [access.workspace.branchName], authoringPaths: true });
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

const principalType = (id: string) => id.startsWith('capacity-provider:') || id.startsWith('service-principal:')
	? 'service' : 'user';
const list = (value: unknown) => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []).map(String).map((item) => item.trim()).filter(Boolean);

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
