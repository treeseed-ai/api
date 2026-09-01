import { createHash } from 'node:crypto';
import { admitDiscussionInvocations, resolveDiscussionInvocationAgents } from '../capacity/services/capacity/invocations/discussion-invocation-service.ts';
import { changeDiscussionStatus, commitDiscussionMessage, loadDiscussions, validateDiscussionContextRefs } from './content.ts';

type Principal = { id: string; roles?: string[]; permissions?: string[]; metadata?: Record<string, unknown> } | undefined;

export class DiscussionServiceError extends Error {
	constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 503, readonly code: string, message: string) {
		super(message);
		this.name = 'DiscussionServiceError';
	}
}

function text(value: unknown, fallback = '') { return typeof value === 'string' && value.trim() ? value.trim() : fallback; }
function record(value: unknown): Record<string, any> {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
	if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; }
	return {};
}
function stableId(scope: string, key: string) { return createHash('sha256').update(`${scope}:${key}`).digest('hex').slice(0, 32); }
function administrator(principal: Principal) { return principal?.roles?.some((role) => ['admin', 'platform_admin'].includes(role)) ?? false; }
function failure(error: unknown, status: 409 | 503, code: string): never {
	if (error instanceof DiscussionServiceError) throw error;
	const value = record(error);
	throw new DiscussionServiceError(Number.isInteger(value.status) ? value.status : status, text(value.code, code),
		'TreeDX Discussion operation failed.');
}

async function projectFor(store: any, principal: Principal, projectId: string) {
	if (!principal) throw new DiscussionServiceError(401, 'authentication_required', 'Authentication is required.');
	const details = await store.getProjectDetails(projectId);
	if (!details?.project) throw new DiscussionServiceError(404, 'project_not_found', 'Project not found.');
	if (!administrator(principal) && !await store.principalCanAccessTeam(principal, details.project.teamId)) {
		throw new DiscussionServiceError(403, 'project_access_denied', 'Project access is required.');
	}
	return details.project;
}

async function cancelArchivedDiscussionCapacity(store: any, projectId: string, discussionId: string,
	cancelPending: (teamId: string, assignmentId: string, idempotencyKey: string) => Promise<unknown>, now = new Date().toISOString()) {
	const candidates = await store.all(`SELECT id,status,metadata_json FROM agent_invocation_requests
		WHERE project_id = ? AND execution_kind = 'conversation' AND status IN ('queued','blocked','admitted','running')`, [projectId]);
	const invocations = candidates.filter((candidate: Record<string, unknown>) => text(record(candidate.metadata_json).discussionId) === discussionId);
	const invocationIds = invocations.map((candidate: Record<string, unknown>) => text(candidate.id)).filter(Boolean);
	const assignments = invocationIds.length ? await store.all(`SELECT id,team_id,invocation_id,status,metadata_json FROM capacity_provider_assignments
		WHERE project_id = ? AND invocation_id IN (${invocationIds.map(() => '?').join(',')}) AND status IN ('pending','leased')`, [projectId, ...invocationIds]) : [];
	const operations = [
		...invocations.filter((candidate: Record<string, unknown>) => ['queued', 'blocked'].includes(text(candidate.status))).map((candidate: Record<string, unknown>) => ({
			query: `UPDATE agent_invocation_requests SET status='cancelled',completed_at=?,blocking_state_json=?,updated_at=? WHERE id=? AND project_id=? AND status IN ('queued','blocked')`,
			params: [now, JSON.stringify({ code: 'discussion_archived', discussionId }), now, candidate.id, projectId],
		})),
		...assignments.filter((assignment: Record<string, unknown>) => text(assignment.status) === 'leased').map((assignment: Record<string, unknown>) => ({
			query: 'UPDATE capacity_provider_assignments SET metadata_json=?,updated_at=? WHERE id=? AND project_id=? AND status IN (\'pending\',\'leased\')',
			params: [JSON.stringify({ ...record(assignment.metadata_json), cancellationRequested: true, cancellationReason: 'discussion_archived', discussionId }), now, assignment.id, projectId],
		})),
	];
	if (operations.length) await store.batch(operations);
	for (const assignment of assignments.filter((candidate: Record<string, unknown>) => text(candidate.status) === 'pending')) {
		const operationKey = `discussion-archive:${projectId}:${discussionId}:${text(assignment.id)}`;
		await cancelPending(text(assignment.team_id), text(assignment.id), operationKey);
		await store.run(`UPDATE agent_invocation_requests SET status='cancelled',completed_at=COALESCE(completed_at,?),blocking_state_json=?,updated_at=?
			WHERE id=? AND project_id=? AND status IN ('admitted','running')`, [now,
			JSON.stringify({ code: 'discussion_archived', discussionId, assignmentId: assignment.id }), now, assignment.invocation_id, projectId]);
	}
}

function continuationEvidence(assignment: Record<string, unknown> | null, discussionId: string, messages: Array<Record<string, unknown>>) {
	if (!assignment) return null;
	const metadata = record(assignment.metadata_json);
	if (text(metadata.operationalState) !== 'suspended') return null;
	const waitingDiscussionId = text(metadata.waitingDiscussionId);
	const waitingMessageId = text(metadata.waitingMessageId);
	if (waitingDiscussionId !== discussionId || !waitingMessageId) {
		throw new DiscussionServiceError(409, 'discussion_continuation_source_mismatch', 'The parent assignment is not suspended on this exact Discussion message.');
	}
	const source = messages.find((message) => text(message.id) === waitingMessageId);
	if (!text(source?.path)) throw new DiscussionServiceError(409, 'discussion_continuation_source_missing',
		'The required-response source message is missing from authoritative TreeDX history.');
	return { replyTo: waitingMessageId, sourceMessageRefs: [waitingMessageId, text(source?.path)] };
}

export function createDiscussionService(dependencies: { store: any; capacity: any; sessionEvents: any }) {
	const { store, capacity, sessionEvents } = dependencies;
	const invocationStore = capacity ?? store;
	return {
		async list(principal: Principal, query: Record<string, unknown>) {
			const projectId = text(query.projectId);
			if (!projectId) throw new DiscussionServiceError(400, 'project_required', 'Discussion history requires a project.');
			await projectFor(store, principal, projectId);
			try {
				const requestedCollection = text(query.collection);
				const collection = ['discussions', 'messages', 'events'].includes(requestedCollection)
					? requestedCollection as 'discussions' | 'messages' | 'events' : undefined;
				return await loadDiscussions({ store, projectId, discussionId: text(query.discussionId) || undefined,
					query: text(query.query) || undefined, collection, limit: Number(query.limit) || undefined, after: text(query.after) || undefined });
			} catch (error) { failure(error, 503, 'discussion_content_unavailable'); }
		},

		async create(principal: Principal, body: Record<string, unknown>, idempotencyKey: string | undefined) {
			if (!principal) throw new DiscussionServiceError(401, 'authentication_required', 'Authentication is required.');
			if (!idempotencyKey) throw new DiscussionServiceError(400, 'idempotency_key_required', 'Discussion mutation requires an idempotency key.');
			const simulatedHuman = body.simulateHuman === true;
			const requestedWorkdayId = text(body.workdayId);
			if (simulatedHuman && (!requestedWorkdayId || !text(body.reason))) throw new DiscussionServiceError(422,
				'simulated_human_evidence_required', 'Simulated-human discussion requires an exact workday and evidence reason.');
			const teamId = text(body.teamId);
			if (!teamId) throw new DiscussionServiceError(400, 'team_required', 'Discussion requires a team.');
			const allowed = administrator(principal) || (simulatedHuman
				? await store.principalCanManageTeam(principal, teamId) : await store.principalCanAccessTeam(principal, teamId));
			if (!allowed) throw new DiscussionServiceError(403, 'team_access_denied', 'Team access is required.');
			let projectId = text(body.projectId);
			if (!projectId) {
				const projects = await store.listTeamProjects(teamId);
				projectId = text(projects.find((project: any) => project.status === 'active' || !project.status)?.id, text(projects[0]?.id));
			}
			if (!projectId) throw new DiscussionServiceError(409, 'discussion_project_required',
				'The team needs an active project with a TreeDX repository before starting a Discussion.');
			const project = await projectFor(store, principal, projectId);
			if (project.teamId !== teamId) throw new DiscussionServiceError(403, 'discussion_project_team_mismatch',
				'Discussion project does not belong to the selected team.');
			const messageBody = text(body.body);
			if (!messageBody || messageBody.length > 20_000) throw new DiscussionServiceError(422, 'discussion_message_invalid',
				'Discussion message must contain between 1 and 20,000 characters.');
			if (body.intent === 'act') throw new DiscussionServiceError(409, 'discussion_operation_handoff_required',
				'Discussion cannot directly create acting authority. Prepare an approval-backed operation handoff instead.');
			const discussionId = text(body.discussionId, `discussion-${stableId(projectId, idempotencyKey)}`);
			const messageId = stableId(discussionId, idempotencyKey);
			const parentWorkdayId = text(body.parentWorkdayId) || null;
			const parentAssignmentId = text(body.parentAssignmentId) || null;
			let contextRefs: Awaited<ReturnType<typeof validateDiscussionContextRefs>> = [];
			let authored: any;
			try {
				const parentAssignment = parentAssignmentId ? await store.first(
					'SELECT id,metadata_json FROM capacity_provider_assignments WHERE id = ? AND team_id = ? AND project_id = ? LIMIT 1',
					[parentAssignmentId, teamId, projectId]) : null;
				if (parentAssignmentId && !parentAssignment) throw new DiscussionServiceError(409, 'discussion_parent_assignment_not_found',
					'The explicit parent assignment does not exist in this team and project.');
				const waitingMessageId = text(record(parentAssignment?.metadata_json).waitingMessageId);
				const continuationHistory = parentAssignment ? await loadDiscussions({ store, projectId, discussionId,
					exactMessageIds: waitingMessageId ? [waitingMessageId] : [], collection: 'messages', limit: 10 }) : { messages: [] };
				const continuation = continuationEvidence(parentAssignment, discussionId, continuationHistory.messages);
				const history = await loadDiscussions({ store, projectId, discussionId, exactMessageIds: [messageId], collection: 'messages' }).catch(() => ({ messages: [] }));
				const replay = history.messages.find((entry: any) => text(entry.id) === messageId);
				if (replay) {
					if (text(replay.body) !== messageBody) throw new DiscussionServiceError(409, 'discussion_idempotency_conflict',
						'The idempotency key is already bound to another discussion message.');
					let invocations = await store.all(`SELECT id,status,execution_id,assignment_id,metadata_json FROM agent_invocation_requests
						WHERE team_id = ? AND idempotency_key LIKE ? ORDER BY id`, [teamId, `${idempotencyKey}:%`]);
					const replayMentions = Array.isArray(replay.frontmatter?.mentionedAgents)
						? replay.frontmatter.mentionedAgents.map((value: unknown) => text(value)).filter(Boolean) : [];
					const replayAgents = await resolveDiscussionInvocationAgents(invocationStore, { teamId, projectId, discussionId,
						parentAssignmentId, mentionedAgents: replayMentions });
					if (replayAgents.length) {
						contextRefs = await validateDiscussionContextRefs({ store, projectId, teamId, values: body.contextRefs });
						invocations = await admitDiscussionInvocations(invocationStore, { teamId, projectId,
							projectSlug: text(project.slug, project.id), discussionId, messageId, messagePath: text(replay.path),
							messageCommit: text(record(invocations[0]?.metadata_json).sourceCommit, text((history as any).ref)), contextRefs, agentSlugs: replayAgents,
							idempotencyKey, parentWorkdayId, parentAssignmentId,
							communication: record(body.communication), addressRequirements: record(body.addressRequirements),
							durationSeconds: Math.max(60, Math.min(3600, Number(body.durationSeconds ?? 900))), requestedById: principal.id });
					}
					return { discussion: { id: discussionId }, message: replay, invocations, replayed: true };
				}
				contextRefs = await validateDiscussionContextRefs({ store, projectId, teamId, values: body.contextRefs });
				const existing = text(body.discussionId) ? await loadDiscussions({ store, projectId, discussionId,
					includeDiscussion: true, collection: 'discussions', limit: 1 }).catch(() => ({ discussions: [] })) : { discussions: [] };
				authored = await commitDiscussionMessage({ store, projectId, teamId, principal, body: messageBody,
					intent: body.intent === 'propose' ? 'propose' : 'discuss', discussionId, messageId,
					createDiscussion: !text(body.discussionId) || (body.createDiscussion === true && existing.discussions.length === 0), topic: text(record(existing.discussions[0]?.frontmatter).topic) || text(body.topic) || undefined,
					fileRefs: Array.isArray(body.fileRefs) ? body.fileRefs : [], contextRefs,
					recipients: Array.isArray(body.recipients) ? body.recipients.map(String) : [],
					inboxIntent: ['comment', 'answer', 'reply'].includes(text(body.inboxIntent)) ? body.inboxIntent as 'comment'|'answer'|'reply' : undefined,
					replyTo: text(body.replyTo) || undefined, ...(continuation ?? {}) });
			} catch (error) { failure(error, 503, 'discussion_content_unavailable'); }
			const observed = await loadDiscussions({ store, projectId, discussionId: authored.discussion.id,
				exactPaths: [authored.message.path], collection: 'messages' });
			const observedMessage = observed.messages.find((entry: any) => text(entry.path) === authored.message.path);
			if (!observedMessage || text(observedMessage.body) !== messageBody) throw new DiscussionServiceError(503,
				'discussion_readback_failed', 'TreeDX did not authoritatively return the committed Discussion message.');
			await sessionEvents.publish({ eventType: 'discussion.updated', teamId, projectId, resourceId: authored.discussion.id,
				payload: { discussionId: authored.discussion.id, messageId: authored.message.id, commitSha: authored.commitSha } }).catch(() => undefined);
			try {
				const agents = await resolveDiscussionInvocationAgents(invocationStore, { teamId, projectId,
					discussionId: authored.discussion.id, parentAssignmentId, mentionedAgents: [...new Set([
						...authored.mentions, ...(Array.isArray(body.recipients) ? body.recipients.map(String) : []),
					])] });
				if (!agents.length) return { ...authored, invocations: [], replayed: false };
				const invocations = await admitDiscussionInvocations(invocationStore, { teamId, projectId,
					projectSlug: text(project.slug, project.id), discussionId: authored.discussion.id, messageId: authored.message.id,
					messagePath: authored.message.path, messageCommit: authored.commitSha, contextRefs, agentSlugs: agents,
					idempotencyKey, parentWorkdayId, parentAssignmentId, durationSeconds: Math.max(60, Math.min(3600, Number(body.durationSeconds ?? 900))),
					communication: record(body.communication), addressRequirements: record(body.addressRequirements),
					requestedById: principal.id });
				return { ...authored, invocations, replayed: false };
			} catch (error) { failure(error, 409, 'discussion_invocation_failed'); }
		},

		async updateStatus(principal: Principal, discussionId: string, body: Record<string, unknown>, idempotencyKey?: string) {
			const projectId = text(body.projectId);
			const status = body.status === 'active' ? 'active' : body.status === 'archived' ? 'archived' : null;
			if (!projectId || !status) throw new DiscussionServiceError(422, 'discussion_status_invalid',
				'Discussion lifecycle requires a project and active or archived status.');
			const project = await projectFor(store, principal, projectId);
			try {
				const result = await changeDiscussionStatus({ store, projectId, teamId: project.teamId, discussionId, status, principal });
				if (status === 'archived') await cancelArchivedDiscussionCapacity(store, projectId, discussionId,
					(teamId, assignmentId, key) => invocationStore.cancelCapacityAssignment(teamId, assignmentId,
						{ idempotencyKey: key, reason: 'The source Discussion was archived.' }));
				await sessionEvents.publish({ eventType: 'discussion.lifecycle', teamId: project.teamId, projectId, resourceId: discussionId,
					payload: { status, commitSha: result.commitSha, idempotencyKey } });
				return result;
			} catch (error) { failure(error, 409, 'discussion_status_failed'); }
		},
	};
}
