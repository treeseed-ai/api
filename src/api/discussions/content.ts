import { createHash, randomUUID } from 'node:crypto';
import { parseFrontmatterDocument, serializeFrontmatterDocument } from '@treeseed/sdk/frontmatter';
import { resolveKnowledgeGatewayConnection } from '../knowledge/gateway-treedx-connection.ts';
import { projectTreeDxCommitSignals } from '../capacity/services/treedx/repositories/treedx-change-projector.ts';

type Row = Record<string, unknown>;
function text(value: unknown, fallback = '') { return typeof value === 'string' && value.trim() ? value.trim() : fallback; }
function slug(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 72) || 'discussion'; }

export function mentionedAgentSlugs(body: string) {
	return [...new Set([...body.matchAll(/(?:^|\s)@([a-z0-9][a-z0-9-]{1,63})\b/giu)].map((match) => match[1]!.toLowerCase()))];
}

export async function loadDiscussions(input: { store: any; projectId: string; discussionId?: string; query?: string }) {
	const connection = await resolveKnowledgeGatewayConnection(input.store, { projectId: input.projectId, write: false, relationPaths: true });
	if (!connection) throw new Error('The project TreeDX repository is unavailable for Discussion history.');
	const selected = input.discussionId ? slug(input.discussionId) : null;
	const patterns = selected
		? [`${connection.contentPath}/discussions/${selected}.mdx`, `${connection.contentPath}/discussion-messages/${selected}/**`, `${connection.contentPath}/discussion-events/${selected}/**`]
		: [`${connection.contentPath}/discussions/**`];
	const listed = await connection.client.listRepositoryPaths({ repoId: connection.repositoryId, ref: connection.baseRef, paths: patterns, kinds: ['blob'], extensions: ['md', 'mdx'], limit: 1_000, allowProtected: true });
	const paths = (listed.entries ?? []).map((entry: unknown) => text((entry as Row)?.path)).filter(Boolean);
	const read = paths.length ? await connection.client.readRepositoryFiles({ repoId: connection.repositoryId, ref: text(listed.resolvedRef, connection.baseRef), paths, encoding: 'utf8', parseFrontmatter: false, allowProtected: true }) : { files: [] };
	const query = text(input.query).toLowerCase();
	const items = (read.files ?? []).map((file: unknown) => {
		const row = file as Row; const path = text(row.path); const parsed = parseFrontmatterDocument(text(row.content));
		return { id: path.split('/').at(-1)?.replace(/\.mdx?$/u, ''), path, frontmatter: parsed.frontmatter, body: parsed.body.trim() };
	}).filter((item: Row) => !query || JSON.stringify(item).toLowerCase().includes(query));
	return {
		ref: text((read as Row).resolvedRef, listed.resolvedRef, connection.baseRef),
		discussions: items.filter((item: Row) => text(item.path).includes('/discussions/')),
		messages: items.filter((item: Row) => text(item.path).includes('/discussion-messages/')).sort((a: Row, b: Row) => text((a.frontmatter as Row)?.createdAt).localeCompare(text((b.frontmatter as Row)?.createdAt))),
		events: items.filter((item: Row) => text(item.path).includes('/discussion-events/')).sort((a: Row, b: Row) => Number((a.frontmatter as Row)?.sequence ?? 0) - Number((b.frontmatter as Row)?.sequence ?? 0)),
	};
}

export async function commitDiscussionMessage(input: {
	store: any; projectId: string; teamId: string; principal: Row; body: string;
	intent: 'discuss' | 'propose' | 'act'; discussionId?: string; topic?: string; fileRefs?: unknown[];
}) {
	const connection = await resolveKnowledgeGatewayConnection(input.store, { projectId: input.projectId, write: true, relationPaths: true });
	if (!connection) throw new Error('The project TreeDX repository is unavailable for Discussion authoring.');
	const now = new Date().toISOString();
	const discussionId = text(input.discussionId, randomUUID());
	const messageId = randomUUID();
	const topic = text(input.topic, input.body.replace(/\s+/gu, ' ').slice(0, 96));
	const mentions = mentionedAgentSlugs(input.body);
	const root = connection.contentPath;
	const discussionPath = `${root}/discussions/${slug(discussionId)}.mdx`;
	const messagePath = `${root}/discussion-messages/${slug(discussionId)}/${messageId}.mdx`;
	const eventPath = `${root}/discussion-events/${slug(discussionId)}/${now.replace(/[^0-9]/gu, '')}-${messageId}.mdx`;
	const authorId = text(input.principal.id, 'unknown-user');
	const authorName = text(input.principal.displayName, input.principal.name, authorId);
	const discussion = serializeFrontmatterDocument({ title: topic, topic, status: 'open', teamId: input.teamId, projectId: input.projectId, visibility: 'team', participantIds: [authorId], agentIds: mentions, createdAt: now, updatedAt: now }, `# ${topic}\n`);
	const message = serializeFrontmatterDocument({ title: `${authorName}: ${topic}`.slice(0, 120), discussionId, authorId, authorType: 'user', intent: input.intent, mentionedAgents: mentions, fileRefs: Array.isArray(input.fileRefs) ? input.fileRefs : [], createdAt: now }, `${input.body}\n`);
	const event = serializeFrontmatterDocument({ title: 'Message committed', discussionId, messageId, phase: 'message.committed', sequence: Date.now(), occurredAt: now, metrics: {}, refs: [messagePath] }, `The user message was committed to TreeDX before assignment dispatch.\n`);
	const branchName = `refs/heads/${connection.authoringBranch.replace(/^refs\/heads\//u, '')}`;
	const workspace = await connection.client.createWorkspace({ workspaceId: `discussion-${randomUUID()}`, repoId: connection.repositoryId, baseRef: branchName, branchName, mode: 'writable', allowedPaths: connection.allowedPaths, ttlSeconds: 600 });
	try {
		if (!input.discussionId) await connection.client.writeFile({ workspaceId: workspace.workspaceId, path: discussionPath, content: discussion, encoding: 'utf8' });
		await connection.client.writeFile({ workspaceId: workspace.workspaceId, path: messagePath, content: message, encoding: 'utf8' });
		await connection.client.writeFile({ workspaceId: workspace.workspaceId, path: eventPath, content: event, encoding: 'utf8' });
		const commit = await connection.client.commit({ workspaceId: workspace.workspaceId, message: `discussion: ${topic}`, author: { name: authorName, email: text(input.principal.email, 'discussion@users.treeseed.local') } });
		await projectTreeDxCommitSignals(input.store, { projectId: input.projectId, commitSha: commit.commitSha, immutableRef: commit.branchName, changedPaths: commit.changedPaths, changeSummary: `Discussion message: ${topic}`, actorType: 'user', actorId: authorId });
		return { discussion: { id: discussionId, topic, path: discussionPath }, message: { id: messageId, authorLabel: authorName, body: input.body, path: messagePath }, event: { path: eventPath }, mentions, commitSha: commit.commitSha, snapshotDigest: createHash('sha256').update(commit.commitSha).digest('hex') };
	} catch (error) {
		await connection.client.closeWorkspace(workspace.workspaceId).catch(() => undefined);
		throw error;
	}
}

export async function appendDiscussionEvent(input: {
	store: any; projectId: string; discussionId: string; event: Row;
}) {
	const connection = await resolveKnowledgeGatewayConnection(input.store, { projectId: input.projectId, write: true, relationPaths: true });
	if (!connection) throw new Error('The project TreeDX repository is unavailable for Discussion event projection.');
	const occurredAt = text(input.event.createdAt, new Date().toISOString());
	const eventId = text(input.event.id, randomUUID());
	const phase = text(input.event.eventType, input.event.type, 'assignment.event');
	const path = `${connection.contentPath}/discussion-events/${slug(input.discussionId)}/${occurredAt.replace(/[^0-9]/gu, '')}-${slug(eventId)}.mdx`;
	const eventRefs = (input.event.refs && typeof input.event.refs === 'object') ? input.event.refs as Row : {};
	const refs = Object.values(eventRefs).flatMap((value) => Array.isArray(value) ? value : [value]).map(String).filter(Boolean);
	const context = (input.event.context && typeof input.event.context === 'object') ? input.event.context as Row : {};
	const source = serializeFrontmatterDocument({
		title: text(input.event.title, phase), discussionId: input.discussionId,
		phase, sequence: Number(input.event.eventIndex ?? Date.now()),
		...(input.event.assignmentId ? { assignmentId: String(input.event.assignmentId) } : {}),
		...(input.event.modeRunId ? { modeRunId: String(input.event.modeRunId) } : {}),
		...(context.agentId ? { agentId: String(context.agentId) } : {}),
		...(context.executionProviderId ? { providerId: String(context.executionProviderId) } : {}),
		occurredAt, metrics: input.event.metadata ?? {}, refs,
	}, `${text(input.event.message, `${phase} recorded.`)}\n`);
	const agentId = text(context.agentId);
	const messagePath = agentId && input.event.modeRunId && ['completed', 'recorded'].includes(text(input.event.status))
		? `${connection.contentPath}/discussion-messages/${slug(input.discussionId)}/${slug(eventId)}.mdx`
		: null;
	const messageSource = messagePath ? serializeFrontmatterDocument({
		title: `${agentId}: ${text(input.event.title, phase)}`.slice(0, 120), discussionId: input.discussionId,
		authorId: agentId, authorType: 'agent', intent: 'discuss', mentionedAgents: [], fileRefs: [], createdAt: occurredAt,
	}, `${text(input.event.message, `${phase} completed.`)}\n`) : null;
	const branchName = `refs/heads/${connection.authoringBranch.replace(/^refs\/heads\//u, '')}`;
	const workspace = await connection.client.createWorkspace({ workspaceId: `discussion-event-${randomUUID()}`, repoId: connection.repositoryId, baseRef: branchName, branchName, mode: 'writable', allowedPaths: connection.allowedPaths, ttlSeconds: 600 });
	try {
		await connection.client.writeFile({ workspaceId: workspace.workspaceId, path, content: source, encoding: 'utf8' });
		if (messagePath && messageSource) await connection.client.writeFile({ workspaceId: workspace.workspaceId, path: messagePath, content: messageSource, encoding: 'utf8' });
		const commit = await connection.client.commit({ workspaceId: workspace.workspaceId, message: `discussion: ${phase}`, author: { name: 'TreeSeed control plane', email: 'control-plane@services.treeseed.local' } });
		await projectTreeDxCommitSignals(input.store, { projectId: input.projectId, commitSha: commit.commitSha, immutableRef: commit.branchName, changedPaths: commit.changedPaths, changeSummary: `Discussion event: ${phase}`, actorType: 'service', actorId: 'discussion-projector' });
		return { path, commitSha: commit.commitSha };
	} catch (error) {
		await connection.client.closeWorkspace(workspace.workspaceId).catch(() => undefined);
		throw error;
	}
}
