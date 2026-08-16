import { createHash, randomUUID } from 'node:crypto';
import { parseFrontmatterDocument, serializeFrontmatterDocument } from '@treeseed/sdk/frontmatter';
import { resolveKnowledgeGatewayConnection } from '../knowledge/gateway-treedx-connection.ts';
import { applyTextChangeset } from '../knowledge/changesets/apply-text-changeset.ts';
import { projectTreeDxCommitSignals } from '../capacity/services/treedx/repositories/treedx-change-projector.ts';
import { recordTreeDxAuthoringState } from '../capacity/services/treedx/repositories/treedx-authoring-journal.ts';
import { listReadableTreeDxAuthoringState } from '../capacity/services/treedx/repositories/treedx-authoring-journal.ts';
import { isAgentAtlasContextReference, type AgentAtlasContextReference } from '@treeseed/sdk/agent-capacity';
import { persistSessionEvent } from '../realtime/session-events.ts';
import { validateContentRecord, type ContentModel } from '@treeseed/sdk/content-operations';
import { discussionWorkspaceOperationKey,openDiscussionWorkspace } from './discussion-workspace.ts';

type Row = Record<string, unknown>;
function text(value: unknown, fallback = '') { return typeof value === 'string' && value.trim() ? value.trim() : fallback; }
function record(value: unknown): Row { if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row; if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; } return {}; }
function slug(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 72) || 'discussion'; }
function normalizedDocument(value: unknown) { return typeof value === 'string' ? value.replaceAll('\r\n', '\n').trimEnd() : ''; }
export function discussionEventPathIdentity(value: string) {
	const readable = value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40) || 'event';
	const digest = createHash('sha256').update(value).digest('hex').slice(0, 24);
	return `${readable}-${digest}`;
}

function discussionModel(path: string): ContentModel {
	if (path.includes('/discussion-messages/')) return 'discussion_message';
	if (path.includes('/discussion-events/')) return 'discussion_event';
	return 'discussion';
}

function assertDiscussionContent(path: string, source: string) {
	const validation = validateContentRecord(discussionModel(path), source);
	if (validation.ok) return validation;
	throw Object.assign(new Error(`Discussion content is invalid at ${path}.`), {
		status: 422, code: 'discussion_content_invalid', details: validation.diagnostics,
	});
}

export function mentionedAgentSlugs(body: string) {
	return [...new Set([...body.matchAll(/(?:^|\s)@([a-z0-9][a-z0-9-]{1,63})\b/giu)].map((match) => match[1]!.toLowerCase()))];
}

export async function loadDiscussions(input: {
	store: any; projectId: string; discussionId?: string; query?: string;
	collection?: 'discussions' | 'messages' | 'events'; limit?: number; after?: string;
}) {
	const connection = await resolveKnowledgeGatewayConnection(input.store, {
		projectId: input.projectId, write: false, communicationPaths: true,
	});
	if (!connection) throw new Error('The project TreeDX repository is unavailable for Discussion history.');
	const discussionRef = `refs/heads/${connection.authoringBranch.replace(/^refs\/heads\//u, '')}`;
	const selected = input.discussionId ? slug(input.discussionId) : null;
	const patterns = selected
		? [`${connection.contentPath}/discussions/${selected}.mdx`, `${connection.contentPath}/discussion-messages/${selected}/**`, `${connection.contentPath}/discussion-events/${selected}/**`]
		: [`${connection.contentPath}/discussions/**`];
	const listed = await connection.client.listRepositoryPaths({ repoId: connection.repositoryId, ref: discussionRef, paths: patterns, kinds: ['blob'], extensions: ['.md', '.mdx'], limit: 1_000, allowProtected: true });
	const readableAuthoring = await listReadableTreeDxAuthoringState(input.store, input.projectId);
	const branchPaths = (listed.entries ?? []).map((entry: unknown) => text((entry as Row)?.path)).filter(Boolean);
	const journalPaths = readableAuthoring.flatMap((state) => Array.isArray(state.changedPaths)
		? state.changedPaths.map((path) => text(path)).filter(Boolean) : []);
	const query = text(input.query).toLowerCase();
	const limit = Math.max(1, Math.min(100, Number(input.limit) || 50));
	const collectionMarker = input.collection === 'messages' ? '/discussion-messages/'
		: input.collection === 'events' ? '/discussion-events/'
		: input.collection === 'discussions' ? '/discussions/' : null;
	const selectedDiscussionPaths = selected ? (path: string) => path === `${connection.contentPath}/discussions/${selected}.mdx`
		|| path.startsWith(`${connection.contentPath}/discussion-messages/${selected}/`)
		|| path.startsWith(`${connection.contentPath}/discussion-events/${selected}/`) : () => true;
	const eligiblePaths = [...new Set([...branchPaths, ...journalPaths])]
		.filter(selectedDiscussionPaths)
		.filter((path) => !collectionMarker || path.includes(collectionMarker));
	const pathMatches = query ? eligiblePaths.filter((path) => path.toLowerCase().includes(query)) : [];
	const boundedPaths = pathMatches.length ? pathMatches.slice(-limit) : [
		...eligiblePaths.filter((path) => path.includes('/discussions/')).slice(-limit),
		...eligiblePaths.filter((path) => path.includes('/discussion-messages/')).slice(-limit),
		...eligiblePaths.filter((path) => path.includes('/discussion-events/')).slice(-limit),
	];
	const selectedPaths = [...new Set(boundedPaths)];
	const paths = branchPaths.filter((path) => selectedPaths.includes(path));
	// Keep the authorized branch identity on the read request. The resolved commit is
	// authoritative evidence, but an unpublished authoring commit is intentionally
	// not known when the short-lived gateway token is minted.
	const read = paths.length ? await connection.client.readRepositoryFiles({ repoId: connection.repositoryId, ref: discussionRef, paths, encoding: 'utf8', parseFrontmatter: false, allowProtected: true }) : { files: [] };
	const latestUnpublishedByPath = new Map<string,string>();
	for (const state of readableAuthoring) {
		const commitSha=text(state.commitSha); const changedPaths=Array.isArray(state.changedPaths)?state.changedPaths.map(String):[];
		for (const path of changedPaths) {
			if (!selectedPaths.includes(path)) continue;
			const isSelectedDiscussion=selected
				? path === `${connection.contentPath}/discussions/${selected}.mdx`
					|| path.startsWith(`${connection.contentPath}/discussion-messages/${selected}/`)
					|| path.startsWith(`${connection.contentPath}/discussion-events/${selected}/`)
				: path.startsWith(`${connection.contentPath}/discussions/`);
			if (isSelectedDiscussion) latestUnpublishedByPath.set(path,commitSha);
		}
	}
	const immutableRefs = [...new Set(latestUnpublishedByPath.values())];
	const immutableConnection = immutableRefs.length ? await resolveKnowledgeGatewayConnection(input.store, {
		projectId: input.projectId, write: false, communicationPaths: true, readRefs: immutableRefs,
	}) : connection;
	if (!immutableConnection) throw new Error('The project TreeDX repository is unavailable for Discussion history.');
	const pathsByCommit=new Map<string,string[]>();
	for(const [path,commit] of latestUnpublishedByPath){if(!commit)continue;const grouped=pathsByCommit.get(commit)??[];grouped.push(path);pathsByCommit.set(commit,grouped);}
	const unpublishedReads=await Promise.all([...pathsByCommit].map(async([ref,commitPaths])=>immutableConnection.client.readRepositoryFiles({repoId:connection.repositoryId,ref,paths:commitPaths,encoding:'utf8',parseFrontmatter:false,allowProtected:true})));
	const filesByPath=new Map<string,unknown>();
	for(const file of read.files??[])filesByPath.set(text((file as Row).path),file);
	for(const result of unpublishedReads)for(const file of result.files??[])filesByPath.set(text((file as Row).path),file);
	const items = [...filesByPath.values()].map((file: unknown) => {
		const row = file as Row; const path = text(row.path); const source = text(row.content);
		assertDiscussionContent(path, source); const parsed = parseFrontmatterDocument(source);
		return { id: path.split('/').at(-1)?.replace(/\.mdx?$/u, ''), path, frontmatter: parsed.frontmatter, body: parsed.body.trim() };
	}).filter((item: Row) => !query || JSON.stringify(item).toLowerCase().includes(query));
	const after = text(input.after);
	const afterFiltered = items.filter((item: Row) => {
		if (!after) return true;
		const frontmatter = record(item.frontmatter);
		return text(frontmatter.createdAt, text(frontmatter.occurredAt)) > after;
	});
	const discussions = afterFiltered.filter((item: Row) => text(item.path).includes('/discussions/')).slice(0, limit);
	const messages = afterFiltered.filter((item: Row) => text(item.path).includes('/discussion-messages/'))
		.sort((a: Row, b: Row) => text((a.frontmatter as Row)?.createdAt).localeCompare(text((b.frontmatter as Row)?.createdAt))).slice(0, limit);
	const events = afterFiltered.filter((item: Row) => text(item.path).includes('/discussion-events/'))
		.sort((a: Row, b: Row) => Number((a.frontmatter as Row)?.sequence ?? 0) - Number((b.frontmatter as Row)?.sequence ?? 0)).slice(0, limit);
	const last = [...messages, ...events].sort((a: Row, b: Row) => {
		const left = record(a.frontmatter); const right = record(b.frontmatter);
		return text(left.createdAt, text(left.occurredAt)).localeCompare(text(right.createdAt, text(right.occurredAt)));
	}).at(-1);
	return {
		ref: text((read as Row).resolvedRef, listed.resolvedRef, discussionRef),
		discussions, messages, events,
		cursor: last ? text(record(last.frontmatter).createdAt, text(record(last.frontmatter).occurredAt)) : after,
	};
}

export async function commitDiscussionMessage(input: {
	store: any; projectId: string; teamId: string; principal: Row; body: string;
	intent: 'discuss' | 'propose'; discussionId?: string; topic?: string; fileRefs?: unknown[]; contextRefs?: AgentAtlasContextReference[];
	authorType?: 'user' | 'agent' | 'system'; messageId?: string;
	createDiscussion?: boolean;
	replyTo?: string | null; sourceMessageRefs?: string[]; recipients?: string[]; authorAgentId?: string | null;
	handoffId?: string | null; parentWorkdayId?: string | null; resultingOperationId?: string | null;
	assignmentId?: string | null;
	authoringRef?: string | null;
}) {
	const authoringRef = text(input.authoringRef);
	if (input.authorType === 'agent' && input.assignmentId && !/^refs\/heads\/assignment_[A-Za-z0-9_-]+$/u.test(authoringRef)) {
		throw Object.assign(new Error('Assignment-authored Discussion messages require the exact isolated assignment ref.'), {
			status: 409, code: 'discussion_assignment_ref_required', details: { assignmentId: input.assignmentId },
		});
	}
	const connection = await resolveKnowledgeGatewayConnection(input.store, { projectId: input.projectId, write: true, communicationPaths: true,
		...(authoringRef ? { workspaceRefs: [authoringRef] } : {}) });
	if (!connection) throw new Error('The project TreeDX repository is unavailable for Discussion authoring.');
	const now = new Date().toISOString();
	const discussionId = text(input.discussionId, randomUUID());
	const messageId = text(input.messageId, randomUUID());
	const topic = text(input.topic, input.body.replace(/\s+/gu, ' ').slice(0, 96));
	const mentions = mentionedAgentSlugs(input.body);
	const recipients = [...new Set((input.recipients ?? []).map((value) => text(value)).filter(Boolean))];
	const mentionedAgents = input.authorType === 'agent'
		? mentions.filter((agentId) => recipients.includes(agentId))
		: [...new Set([...mentions, ...recipients])];
	const root = connection.contentPath;
	const discussionPath = `${root}/discussions/${slug(discussionId)}.mdx`;
	const messagePath = `${root}/discussion-messages/${slug(discussionId)}/${messageId}.mdx`;
	const eventPath = `${root}/discussion-events/${slug(discussionId)}/${now.replace(/[^0-9]/gu, '')}-${messageId}.mdx`;
	const authorId = text(input.principal.id, 'unknown-user');
	const authorName = text(input.principal.displayName, input.principal.name, authorId);
	const discussion = serializeFrontmatterDocument({ title: topic, topic, status: 'active', teamId: input.teamId, projectId: input.projectId, visibility: 'team', participantIds: [authorId], agentIds: mentions, createdAt: now, updatedAt: now }, `# ${topic}\n`);
	const message = serializeFrontmatterDocument({ title: `${authorName}: ${topic}`.slice(0, 120), discussionId, authorId, authorType: input.authorType ?? 'user', intent: input.intent,
		mentionedAgents, recipientIds: recipients, fileRefs: Array.isArray(input.fileRefs) ? input.fileRefs : [], contextRefs: input.contextRefs ?? [],
		...(input.replyTo ? { replyTo: input.replyTo } : {}), sourceMessageRefs: input.sourceMessageRefs ?? [],
		...(input.authorAgentId ? { authorAgentId: input.authorAgentId } : {}), ...(input.handoffId ? { handoffId: input.handoffId } : {}),
		...(input.parentWorkdayId ? { parentWorkdayId: input.parentWorkdayId } : {}), ...(input.resultingOperationId ? { resultingOperationId: input.resultingOperationId } : {}), createdAt: now }, `${input.body}\n`);
	const event = serializeFrontmatterDocument({ title: 'Message committed', discussionId, messageId, phase: 'message.committed', sequence: Date.now(), occurredAt: now, metrics: {}, refs: [messagePath] }, `The user message was committed to TreeDX before assignment dispatch.\n`);
	for (const [path, source] of [[discussionPath, discussion], [messagePath, message], [eventPath, event]]) {
		assertDiscussionContent(path, source);
	}
	const branchName = authoringRef || `refs/heads/${connection.authoringBranch.replace(/^refs\/heads\//u, '')}`;
	const session = await openDiscussionWorkspace({ store:input.store,connection,projectId:input.projectId,branchName,
		operationKey:discussionWorkspaceOperationKey('message',`${discussionId}\n${messageId}`) });
	const workspace = session.workspace;
	try {
		const changeset = await applyTextChangeset({ client: connection.client, workspace, changes: [
			...(input.createDiscussion === true || !input.discussionId ? [{ path: discussionPath, before: null, after: discussion }] : []),
			{ path: messagePath, before: null, after: message },
			{ path: eventPath, before: null, after: event },
		] });
		const commit = await connection.client.commit({ workspaceId: workspace.workspaceId, message: `discussion: ${topic}`, author: { name: authorName, email: text(input.principal.email, 'discussion@users.treeseed.local') } });
		const actorType = input.authorType === 'agent' ? 'agent' : input.authorType === 'system' ? 'service' : 'user';
		if (actorType === 'agent') {
			await recordTreeDxAuthoringState(input.store,'unpublished',{ projectId:input.projectId,repositoryId:connection.repositoryId,commitSha:commit.commitSha,ref:commit.branchName,changedPaths:commit.changedPaths,assignmentId:input.assignmentId ?? null,actorType,actorId:authorId });
		} else {
			if (commit.changedPaths.length) {
				const readConnection = await resolveKnowledgeGatewayConnection(input.store, { projectId: input.projectId, write: false,
					communicationPaths: true, readRefs: [commit.commitSha] });
				if (!readConnection) throw new Error('The project TreeDX repository is unavailable for Discussion message read-back.');
				const read = await readConnection.client.readRepositoryFiles({ repoId: connection.repositoryId, ref: commit.commitSha,
					paths: commit.changedPaths, encoding: 'utf8', parseFrontmatter: false, allowProtected: true });
				const observedPaths = (read.files ?? []).map((file: unknown) => text((file as Row).path));
				if (text((read as Row).resolvedRef) !== commit.commitSha || commit.changedPaths.some((path: string) => !observedPaths.includes(path))) {
					throw Object.assign(new Error('Discussion message did not pass exact TreeDX read-back.'), {
						status: 502, code: 'discussion_message_readback_failed', details: { commitSha: commit.commitSha, observedPaths },
					});
				}
			}
			await recordTreeDxAuthoringState(input.store,'integrated',{ projectId:input.projectId,repositoryId:connection.repositoryId,
				commitSha:commit.commitSha,ref:commit.branchName,changedPaths:commit.changedPaths,assignmentId:input.assignmentId ?? null,
				actorType,actorId:authorId });
		}
		await projectTreeDxCommitSignals(input.store, { projectId: input.projectId, commitSha: commit.commitSha, immutableRef: commit.branchName, changedPaths: commit.changedPaths, changeSummary: `Discussion message: ${topic}`, actorType: input.authorType === 'agent' ? 'agent' : input.authorType === 'system' ? 'service' : 'user', actorId: authorId });
		await session.close();
		return { discussion: { id: discussionId, topic, path: discussionPath }, message: { id: messageId, authorLabel: authorName, body: input.body, path: messagePath }, event: { path: eventPath }, mentions, commitSha: commit.commitSha, changeset: { ...changeset, resultCommitSha: commit.commitSha }, snapshotDigest: createHash('sha256').update(commit.commitSha).digest('hex') };
	} catch (error) {
		await session.close().catch(() => undefined);
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
	store: any; projectId: string; teamId: string; discussionId: string; event: Row;
}) {
	const connection = await resolveKnowledgeGatewayConnection(input.store, { projectId: input.projectId, write: true, communicationPaths: true });
	if (!connection) throw new Error('The project TreeDX repository is unavailable for Discussion event projection.');
	const occurredAt = text(input.event.createdAt, new Date().toISOString());
	const eventId = text(input.event.id, randomUUID());
	const phase = text(input.event.eventType, input.event.type, 'assignment.event');
	const path = `${connection.contentPath}/discussion-events/${slug(input.discussionId)}/${occurredAt.replace(/[^0-9]/gu, '')}-${discussionEventPathIdentity(eventId)}.mdx`;
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
	assertDiscussionContent(path, source);
	const branchName = `refs/heads/${connection.authoringBranch.replace(/^refs\/heads\//u, '')}`;
	const journalIntegratedEvent = async (commitSha: string, changedPaths: string[]) => {
		if (!/^[a-f0-9]{40}$/u.test(commitSha)) throw Object.assign(new Error('Discussion event projection requires an exact commit read-back.'), {
			status: 502, code: 'discussion_event_commit_invalid', details: { path, commitSha },
		});
		const readConnection = await resolveKnowledgeGatewayConnection(input.store, {
			projectId: input.projectId, write: false, communicationPaths: true, readRefs: [commitSha],
		});
		if (!readConnection) throw new Error('The project TreeDX repository is unavailable for Discussion event read-back.');
		const read = await readConnection.client.readRepositoryFiles({
			repoId: connection.repositoryId, ref: commitSha, paths: [path], encoding: 'utf8', parseFrontmatter: false, allowProtected: true,
		});
		const observed = (read.files ?? [])[0] as Row | undefined;
		if (text((read as Row).resolvedRef) !== commitSha || text(observed?.path) !== path
			|| normalizedDocument(observed?.content) !== normalizedDocument(source)) {
			throw Object.assign(new Error('Discussion event projection did not pass exact TreeDX read-back.'), {
				status: 502, code: 'discussion_event_readback_failed', details: { path, commitSha, resolvedRef: text((read as Row).resolvedRef) },
			});
		}
		await recordTreeDxAuthoringState(input.store, 'integrated', {
			projectId: input.projectId, repositoryId: connection.repositoryId, commitSha, ref: branchName,
			changedPaths, assignmentId: text(input.event.assignmentId) || null,
			actorType: 'service', actorId: 'discussion-projector',
		});
	};
	const observeExisting = async () => {
		const read = await connection.client.readRepositoryFiles({ repoId: connection.repositoryId, ref: branchName, paths: [path], encoding: 'utf8', parseFrontmatter: false, allowProtected: true })
			.catch((error: unknown) => record(error).code === 'not_found' ? null : Promise.reject(error));
		if (!read) return null;
		const existing = (read.files ?? [])[0] as Row | undefined;
		if (!existing) return null;
		if (normalizedDocument(existing.content) !== normalizedDocument(source)) throw Object.assign(new Error('Discussion event identity is bound to different durable content.'), {
			status: 409, code: 'discussion_event_idempotency_conflict', details: { path },
		});
		const commitSha = text((read as Row).resolvedRef);
		await journalIntegratedEvent(commitSha, [path]);
		return { path, commitSha, changeset: { changedPaths: [], resultCommitSha: commitSha }, replayed: true };
	};
	const observed = await observeExisting();
	if (observed) return observed;
	const session = await openDiscussionWorkspace({ store:input.store,connection,projectId:input.projectId,branchName,
		operationKey:discussionWorkspaceOperationKey('event',path) });
	const workspace = session.workspace;
	try {
		const changeset = await applyTextChangeset({ client: connection.client, workspace, changes: [{ path, before: null, after: source }] });
		const commit = await connection.client.commit({ workspaceId: workspace.workspaceId, message: `discussion: ${phase}`, author: { name: 'TreeSeed control plane', email: 'control-plane@services.treeseed.local' } });
		await journalIntegratedEvent(commit.commitSha, commit.changedPaths);
		await projectTreeDxCommitSignals(input.store, { projectId: input.projectId, commitSha: commit.commitSha, immutableRef: commit.branchName, changedPaths: commit.changedPaths, changeSummary: `Discussion event: ${phase}`, actorType: 'service', actorId: 'discussion-projector' });
		await persistSessionEvent(input.store, { eventType: 'discussion.updated', teamId: input.teamId, projectId: input.projectId, resourceId: input.discussionId, payload: { discussionId: input.discussionId, phase, commitSha: commit.commitSha } })
			.catch((error: unknown) => console.warn('[api] Discussion projection session event degraded', { error: error instanceof Error ? error.message : String(error) }));
		await session.close();
		return { path, commitSha: commit.commitSha, changeset: { ...changeset, resultCommitSha: commit.commitSha } };
	} catch (error) {
		await session.close().catch(() => undefined);
		if (record(error).code === 'conflict') {
			const replay = await observeExisting();
			if (replay) return replay;
		}
		throw error;
	}
}

export async function changeDiscussionStatus(input:{store:any;projectId:string;teamId:string;discussionId:string;status:'active'|'archived';principal:Row}){
	const connection=await resolveKnowledgeGatewayConnection(input.store,{projectId:input.projectId,write:true,communicationPaths:true});
	if(!connection)throw new Error('The project TreeDX repository is unavailable for Discussion lifecycle changes.');
	const path=`${connection.contentPath}/discussions/${slug(input.discussionId)}.mdx`; const branchName=`refs/heads/${connection.authoringBranch.replace(/^refs\/heads\//u,'')}`;
	const read=await connection.client.readRepositoryFiles({repoId:connection.repositoryId,ref:branchName,paths:[path],encoding:'utf8',parseFrontmatter:false,allowProtected:true}); const file=(read.files??[])[0] as Row|undefined;
	if(!file)throw Object.assign(new Error('Unknown Discussion.'),{status:404,code:'discussion_not_found'});
	const before=text(file.content); const parsed=parseFrontmatterDocument(before); const prior=text(parsed.frontmatter.status);
	if(prior===input.status)return {discussionId:input.discussionId,path,status:input.status,replayed:true,commitSha:text((read as Row).resolvedRef,branchName)};
	const now=new Date().toISOString(); const after=serializeFrontmatterDocument({...parsed.frontmatter,status:input.status,...((prior==='open'||prior==='resolved')?{legacyStatus:prior}:{}),updatedAt:now},parsed.body); assertDiscussionContent(path,after);
	const session=await openDiscussionWorkspace({store:input.store,connection,projectId:input.projectId,branchName,
		operationKey:discussionWorkspaceOperationKey('status',`${input.discussionId}\n${input.status}`)}); const workspace=session.workspace;
	try{
		await applyTextChangeset({client:connection.client,workspace,changes:[{path,before,after}]}); const actor=text(input.principal.displayName,input.principal.id,'Discussion operator');
		const commit=await connection.client.commit({workspaceId:workspace.workspaceId,message:`discussion: ${input.status} ${input.discussionId}`,author:{name:actor,email:text(input.principal.email,'discussion@users.treeseed.local')}});
		await recordTreeDxAuthoringState(input.store,'unpublished',{projectId:input.projectId,repositoryId:connection.repositoryId,commitSha:commit.commitSha,ref:commit.branchName,changedPaths:commit.changedPaths,actorType:'user',actorId:text(input.principal.id)});
		await projectTreeDxCommitSignals(input.store,{projectId:input.projectId,commitSha:commit.commitSha,immutableRef:commit.branchName,changedPaths:commit.changedPaths,changeSummary:`Discussion ${input.status}`,actorType:'user',actorId:text(input.principal.id)});
		await session.close(); return {discussionId:input.discussionId,path,status:input.status,replayed:false,commitSha:commit.commitSha,priorStatus:prior};
	}catch(error){await session.close().catch(()=>undefined);throw error;}
}
