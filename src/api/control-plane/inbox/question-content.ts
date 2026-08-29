import { createHash, randomUUID } from 'node:crypto';
import { serializeFrontmatterDocument } from '../../content/frontmatter.ts';
import { applyTextChangeset } from '../../knowledge/changesets/apply-text-changeset.ts';
import { projectLibraryPath, resolveKnowledgeGatewayConnection } from '../../knowledge/gateway-treedx-connection.ts';
import { recordTreeDxAuthoringState } from '../../capacity/services/treedx/repositories/treedx-authoring-journal.ts';

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 72) || 'question';

export async function commitInboxQuestion(input: { store: any; teamId: string; projectId: string; principal: Record<string, any>; title: string; markdown: string; relatedObjectives: string[] }) {
	const connection = await resolveKnowledgeGatewayConnection(input.store, { projectId: input.projectId, write: true });
	if (!connection) throw Object.assign(new Error('The project TreeDX repository is unavailable for question authoring.'), { status: 503, code: 'inbox_treedx_unavailable' });
	const id = `question-${randomUUID()}`, now = new Date().toISOString();
	const path = projectLibraryPath(connection.contentPath, 'questions', `${slug(input.title)}-${id.slice(-8)}.mdx`);
	const source = serializeFrontmatterDocument({ id, title: input.title, status: 'open', questionType: 'team-human', relatedObjectives: input.relatedObjectives,
		createdBy: input.principal.id, createdAt: now, updatedAt: now }, `${input.markdown.trim()}\n`);
	const branchName = `refs/heads/${connection.authoringBranch.replace(/^refs\/heads\//u, '')}`;
	const workspace = await connection.client.createWorkspace({ repoId: connection.repositoryId, baseRef: connection.baseRef, branchName });
	try {
		await applyTextChangeset({ client: connection.client, workspace, changes: [{ path, before: null, after: source }] });
		const commit = await connection.client.commit({ workspaceId: workspace.workspaceId, message: `question: ${input.title}`, author: { name: input.principal.displayName ?? input.principal.id, email: input.principal.email ?? 'inbox@users.treeseed.local' } });
		const reader = await resolveKnowledgeGatewayConnection(input.store, { projectId: input.projectId, write: false, readRefs: [commit.commitSha] });
		if (!reader) throw new Error('TreeDX exact-ref question read-back is unavailable.');
		const observed = await reader.client.readRepositoryFiles({ repoId: connection.repositoryId, ref: commit.commitSha, paths: [path], encoding: 'utf8', parseFrontmatter: false, allowProtected: true });
		if (String((observed as any).resolvedRef) !== commit.commitSha || String((observed.files ?? [])[0]?.content ?? '').trimEnd() !== source.trimEnd()) throw Object.assign(new Error('Question did not pass exact TreeDX read-back.'), { status: 502, code: 'inbox_question_readback_failed' });
		await recordTreeDxAuthoringState(input.store, 'integrated', { projectId: input.projectId, repositoryId: connection.repositoryId, commitSha: commit.commitSha,
			ref: commit.branchName, changedPaths: commit.changedPaths, assignmentId: null, actorType: 'user', actorId: input.principal.id });
		await connection.client.closeWorkspace(workspace.workspaceId).catch(() => undefined);
		return { id, path, source, commitSha: commit.commitSha, repositoryId: connection.repositoryId, digest: createHash('sha256').update(source).digest('hex'), createdAt: now };
	} catch (error) { await connection.client.closeWorkspace(workspace.workspaceId).catch(() => undefined); throw error; }
}
