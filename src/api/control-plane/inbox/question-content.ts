import { createHash, randomUUID } from 'node:crypto';
import { parseFrontmatterDocument, serializeFrontmatterDocument } from '../../content/frontmatter.ts';
import { exactEntityReferenceSchema } from '@treeseed/sdk/agent-capacity';
import { applyTextChangeset } from '../../knowledge/changesets/apply-text-changeset.ts';
import { projectLibraryPath, resolveKnowledgeGatewayConnection } from '../../knowledge/gateway-treedx-connection.ts';
import { recordTreeDxAuthoringState } from '../../capacity/services/treedx/repositories/treedx-authoring-journal.ts';
import { discussionWorkspaceOperationKey, openDiscussionWorkspace } from '../../discussions/discussion-workspace.ts';

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 72) || 'question';

export function inboxQuestionReference(row: Record<string, unknown>) {
	const digest = String(row.digest ?? '');
	return exactEntityReferenceSchema.parse({ store: 'treedx', model: 'question', id: row.id, revision: Number(row.version),
		digest: digest.startsWith('sha256:') ? digest : `sha256:${digest}`, repository: row.repository_id,
		path: row.content_path, commit: row.commit_sha });
}

export async function commitInboxQuestion(input: { store: any; teamId: string; projectId: string; principal: Record<string, any>; title: string; markdown: string;
	severity: 'blocking' | 'advisory'; relatedObjectives: string[]; relatedProposals: string[]; relatedDecisions: string[]; relatedWorkItems: string[] }) {
	const library = await input.store.getProjectTreeDxLibrary(input.projectId);
	if (!library) throw Object.assign(new Error('The project TreeDX repository is unavailable for question authoring.'), { status: 503, code: 'inbox_treedx_unavailable' });
	const id = `question-${randomUUID()}`, now = new Date().toISOString();
	const path = projectLibraryPath(library.contentPath, 'questions', `${slug(input.title)}-${id.slice(-8)}.mdx`);
	const connection = await resolveKnowledgeGatewayConnection(input.store, { projectId: input.projectId, write: true, workspacePaths: [path] });
	if (!connection) throw Object.assign(new Error('The project TreeDX repository is unavailable for question authoring.'), { status: 503, code: 'inbox_treedx_unavailable' });
	const source = serializeFrontmatterDocument({ id, title: input.title, status: 'open', severity: input.severity, questionType: 'strategy',
		relatedObjectives: input.relatedObjectives, relatedProposals: input.relatedProposals, relatedDecisions: input.relatedDecisions,
		relatedWorkItems: input.relatedWorkItems,
		createdBy: input.principal.id, createdAt: now, updatedAt: now }, `${input.markdown.trim()}\n`);
	const branchName = `refs/heads/${connection.authoringBranch.replace(/^refs\/heads\//u, '')}`;
	const session = await openDiscussionWorkspace({ store: input.store, connection: { ...connection, allowedPaths: [path] },
		projectId: input.projectId, baseRef: connection.baseRef, branchName, operationKey: discussionWorkspaceOperationKey('question', id) });
	const workspace = session.workspace;
	try {
		await applyTextChangeset({ client: connection.client, workspace, changes: [{ path, before: null, after: source }] });
		const commit = await connection.client.commit({ workspaceId: workspace.workspaceId, message: `question: ${input.title}`, author: { name: input.principal.displayName ?? input.principal.id, email: input.principal.email ?? 'inbox@users.treeseed.local' } });
		const reader = await resolveKnowledgeGatewayConnection(input.store, { projectId: input.projectId, write: false, readRefs: [commit.commitSha], workspacePaths: [path] });
		if (!reader) throw new Error('TreeDX exact-ref question read-back is unavailable.');
		const observed = await reader.client.readRepositoryFiles({ repoId: connection.repositoryId, ref: commit.commitSha, paths: [path], encoding: 'utf8', parseFrontmatter: false, allowProtected: true });
		if (String((observed as any).resolvedRef) !== commit.commitSha || observed.files?.length !== 1 || observed.files[0]?.path !== path || observed.files[0]?.content !== source) throw Object.assign(new Error('Question did not pass exact TreeDX read-back.'), { status: 502, code: 'inbox_question_readback_failed' });
		await recordTreeDxAuthoringState(input.store, 'integrated', { projectId: input.projectId, repositoryId: connection.repositoryId, commitSha: commit.commitSha,
			ref: commit.branchName, changedPaths: commit.changedPaths, assignmentId: null, actorType: 'user', actorId: input.principal.id });
		return { id, path, source, commitSha: commit.commitSha, repositoryId: connection.repositoryId, digest: createHash('sha256').update(source).digest('hex'), createdAt: now };
	} finally { await session.close(); }
}

/** Resolve a question only from its exact committed answer, never a body digest
 * or a mutable discussion branch. Both human and agent answers use this path. */
export async function readInboxQuestionAnswer(input: { store: any; projectId: string; discussionId: string;
	path: string; commit: string; authorId: string }) {
	const invalid = () => Object.assign(new Error('The question answer lacks exact TreeDX discussion-message authority.'),
		{ status: 503, code: 'inbox_answer_readback_failed' });
	if (!/^[a-f0-9]{40}$/u.test(input.commit)) throw invalid();
	const library = await input.store.getProjectTreeDxLibrary(input.projectId);
	if (!library || !input.discussionId) throw invalid();
	const prefix = `${projectLibraryPath(library.contentPath, 'discussion-messages', slug(input.discussionId))}/`;
	if (!input.path.startsWith(prefix) || input.path.slice(prefix.length).includes('/') || !input.path.endsWith('.mdx')) throw invalid();
	const reader = await resolveKnowledgeGatewayConnection(input.store, { projectId: input.projectId, write: false,
		readRefs: [input.commit], workspacePaths: [input.path] });
	if (!reader) throw invalid();
	const observed = await reader.client.readRepositoryFiles({ repoId: reader.repositoryId, ref: input.commit,
		paths: [input.path], encoding: 'utf8', parseFrontmatter: false, allowProtected: true });
	const file = observed.files?.[0];
	if (observed.resolvedRef !== input.commit || observed.files?.length !== 1 || file?.path !== input.path || typeof file.content !== 'string') throw invalid();
	const parsed = parseFrontmatterDocument(file.content), metadata = parsed.frontmatter;
	if (metadata.schemaVersion !== 'treeseed.discussion-message/v1' || metadata.discussionId !== input.discussionId
		|| metadata.inboxIntent !== 'answer' || metadata.authorId !== input.authorId || !parsed.body.trim()) throw invalid();
	return exactEntityReferenceSchema.parse({ store: 'treedx', model: 'discussion-message', id: metadata.id,
		revision: 1, digest: `sha256:${createHash('sha256').update(file.content).digest('hex')}`,
		repository: reader.repositoryId, path: input.path, commit: input.commit });
}
