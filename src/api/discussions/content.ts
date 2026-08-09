import { createHash, randomUUID } from 'node:crypto';
import { parseFrontmatterDocument, serializeFrontmatterDocument } from '@treeseed/sdk/frontmatter';
import { resolveKnowledgeGatewayConnection } from '../knowledge/gateway-treedx-connection.ts';
import { applyTextChangeset } from '../knowledge/changesets/apply-text-changeset.ts';
import { projectTreeDxCommitSignals } from '../capacity/services/treedx/repositories/treedx-change-projector.ts';
import { isAgentAtlasContextReference, type AgentAtlasContextReference } from '@treeseed/sdk/agent-capacity';

type Row = Record<string, unknown>;
function text(value: unknown, fallback = '') { return typeof value === 'string' && value.trim() ? value.trim() : fallback; }
function record(value: unknown): Row { if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row; if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; } return {}; }
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
	intent: 'discuss' | 'propose' | 'act'; discussionId?: string; topic?: string; fileRefs?: unknown[]; contextRefs?: AgentAtlasContextReference[];
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
	const message = serializeFrontmatterDocument({ title: `${authorName}: ${topic}`.slice(0, 120), discussionId, authorId, authorType: 'user', intent: input.intent, mentionedAgents: mentions, fileRefs: Array.isArray(input.fileRefs) ? input.fileRefs : [], contextRefs: input.contextRefs ?? [], createdAt: now }, `${input.body}\n`);
	const event = serializeFrontmatterDocument({ title: 'Message committed', discussionId, messageId, phase: 'message.committed', sequence: Date.now(), occurredAt: now, metrics: {}, refs: [messagePath] }, `The user message was committed to TreeDX before assignment dispatch.\n`);
	const branchName = `refs/heads/${connection.authoringBranch.replace(/^refs\/heads\//u, '')}`;
	const workspace = await connection.client.createWorkspace({ workspaceId: `discussion-${randomUUID()}`, repoId: connection.repositoryId, baseRef: branchName, branchName, mode: 'writable', allowedPaths: connection.allowedPaths, ttlSeconds: 600 });
	try {
		const changeset = await applyTextChangeset({ client: connection.client, workspace, changes: [
			...(!input.discussionId ? [{ path: discussionPath, before: null, after: discussion }] : []),
			{ path: messagePath, before: null, after: message },
			{ path: eventPath, before: null, after: event },
		] });
		const commit = await connection.client.commit({ workspaceId: workspace.workspaceId, message: `discussion: ${topic}`, author: { name: authorName, email: text(input.principal.email, 'discussion@users.treeseed.local') } });
		await projectTreeDxCommitSignals(input.store, { projectId: input.projectId, commitSha: commit.commitSha, immutableRef: commit.branchName, changedPaths: commit.changedPaths, changeSummary: `Discussion message: ${topic}`, actorType: 'user', actorId: authorId });
		return { discussion: { id: discussionId, topic, path: discussionPath }, message: { id: messageId, authorLabel: authorName, body: input.body, path: messagePath }, event: { path: eventPath }, mentions, commitSha: commit.commitSha, changeset: { ...changeset, resultCommitSha: commit.commitSha }, snapshotDigest: createHash('sha256').update(commit.commitSha).digest('hex') };
	} catch (error) {
		await connection.client.closeWorkspace(workspace.workspaceId).catch(() => undefined);
		throw error;
	}
}

export async function validateDiscussionContextRefs(input: { store: any; teamId: string; projectId: string; values: unknown }): Promise<AgentAtlasContextReference[]> {
	const values = Array.isArray(input.values) ? input.values.slice(0, 24) : [];
	if (values.some((value) => !isAgentAtlasContextReference(value))) throw Object.assign(new Error('Discussion context contains an invalid Atlas reference.'), { status: 422, code: 'discussion_context_invalid' });
	const references = values as AgentAtlasContextReference[];
	if (references.some((reference) => reference.projectId !== input.projectId)) throw Object.assign(new Error('Discussion context must belong to the selected project.'), { status: 403, code: 'discussion_context_project_forbidden' });
	const workdays = new Map<string, Record<string, unknown>>();
	for (const reference of references) {
		if (reference.workdayId) {
			const run = workdays.get(reference.workdayId) ?? await input.store.first('SELECT id, parameters_json FROM capacity_workday_runs WHERE id = ? AND team_id = ? LIMIT 1', [reference.workdayId, input.teamId]);
			if (!run) throw Object.assign(new Error('Discussion context references an unknown workday.'), { status: 409, code: 'discussion_context_workday_stale' });
			workdays.set(reference.workdayId, run);
			if (['agent', 'group', 'project', 'profile', 'signal'].includes(reference.kind)) {
				const parameters = record(run.parameters_json);
				const topologies = Object.values(record(parameters.atlasTopologyByProjectId)).map(record);
				const topology = topologies.find((candidate) => String(candidate.projectId) === input.projectId);
				const nodes = Array.isArray(topology?.nodes) ? topology.nodes.map(record) : [];
				const edges = Array.isArray(topology?.edges) ? topology.edges.map(record) : [];
				const found = reference.kind === 'signal'
					? edges.some((edge) => String(edge.id) === reference.id || String(edge.contractId) === reference.id)
					: reference.kind === 'profile'
						? nodes.some((node) => String(node.activityProfile) === reference.id)
						: nodes.some((node) => String(node.id) === reference.id && String(node.kind) === reference.kind);
				if (!found || (reference.immutableRef && String(topology?.immutableRef) !== reference.immutableRef)) throw Object.assign(new Error('Discussion context topology evidence is stale.'), { status: 409, code: 'discussion_context_topology_stale' });
			}
		}
		if (reference.kind === 'event' && reference.workdayId && reference.eventSequence !== undefined) {
			const event = await input.store.first('SELECT id FROM capacity_workday_events WHERE team_id = ? AND run_id = ? AND event_index = ? LIMIT 1', [input.teamId, reference.workdayId, reference.eventSequence]);
			if (!event || String(event.id) !== reference.id) throw Object.assign(new Error('Discussion context event evidence is stale.'), { status: 409, code: 'discussion_context_event_stale' });
		}
		if (reference.kind === 'assignment') {
			const assignment = await input.store.first('SELECT id FROM capacity_provider_assignments WHERE id = ? AND team_id = ? AND project_id = ? LIMIT 1', [reference.id, input.teamId, input.projectId]);
			if (!assignment) throw Object.assign(new Error('Discussion context references an unknown assignment.'), { status: 409, code: 'discussion_context_assignment_stale' });
		}
		if (reference.kind === 'proposal') {
			const proposal = await input.store.first('SELECT id FROM governance_proposals WHERE id = ? AND team_id = ? AND project_id = ? LIMIT 1', [reference.id, input.teamId, input.projectId]);
			if (!proposal) throw Object.assign(new Error('Discussion context references an unknown proposal.'), { status: 409, code: 'discussion_context_proposal_stale' });
		}
		if (reference.kind === 'decision') {
			const decision = await input.store.first('SELECT id FROM governance_decisions WHERE id = ? AND team_id = ? AND project_id = ? LIMIT 1', [reference.id, input.teamId, input.projectId]);
			if (!decision) throw Object.assign(new Error('Discussion context references an unknown decision.'), { status: 409, code: 'discussion_context_decision_stale' });
		}
	}
	return references;
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
		const changeset = await applyTextChangeset({ client: connection.client, workspace, changes: [
			{ path, before: null, after: source },
			...(messagePath && messageSource ? [{ path: messagePath, before: null, after: messageSource }] : []),
		] });
		const commit = await connection.client.commit({ workspaceId: workspace.workspaceId, message: `discussion: ${phase}`, author: { name: 'TreeSeed control plane', email: 'control-plane@services.treeseed.local' } });
		await projectTreeDxCommitSignals(input.store, { projectId: input.projectId, commitSha: commit.commitSha, immutableRef: commit.branchName, changedPaths: commit.changedPaths, changeSummary: `Discussion event: ${phase}`, actorType: 'service', actorId: 'discussion-projector' });
		return { path, commitSha: commit.commitSha, changeset: { ...changeset, resultCommitSha: commit.commitSha } };
	} catch (error) {
		await connection.client.closeWorkspace(workspace.workspaceId).catch(() => undefined);
		throw error;
	}
}
