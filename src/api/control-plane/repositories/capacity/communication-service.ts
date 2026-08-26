import { normalizeCapacityPageLimit } from '@treeseed/sdk/capacity-pagination';
import { parseCommunicationAddresses } from '@treeseed/sdk/operator-contracts';
import { createHash } from 'node:crypto';
import { authorizeCapacityTeam, type CapacityPrincipal } from './capacity-authorization.ts';
import { CapacityOperationError } from './capacity-operation-error.ts';
import { loadDiscussions } from '../../../discussions/content.ts';

type Row = Record<string, unknown>;
type ProviderSnapshot = Row & { maxConcurrentRunners?: number; lanes?: unknown[] };

function readiness(session: Row) {
	let providers: ProviderSnapshot[] = [];
	let metadata: Row = {};
	try {
		providers = JSON.parse(String(session.execution_providers_json ?? '[]')) as ProviderSnapshot[];
		metadata = JSON.parse(String(session.metadata_json ?? '{}')) as Row;
	} catch {
		return { ...session, communicationReady: false, sourceClosureDigest: null, blockers: ['provider_snapshot_invalid'] };
	}
	const ready = providers.some((provider) => Array.isArray(provider.lanes)
		&& provider.lanes.some((lane) => (lane as Row).purpose === 'communication'));
	return { ...session, sourceClosureDigest: typeof metadata.sourceClosureDigest === 'string' ? metadata.sourceClosureDigest : null,
		communicationReady: ready, blockers: ready ? [] : ['provider_communication_lane_unavailable'] };
}

function terminal(status: unknown) {
	return ['completed', 'failed', 'cancelled', 'returned', 'expired'].includes(String(status));
}

function record(value: unknown): Row {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row;
	if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; }
	return {};
}

function text(value: unknown, fallback = '') { return typeof value === 'string' && value.trim() ? value.trim() : fallback; }
function stableId(scope: string, value: string) { return createHash('sha256').update(`${scope}:${value}`).digest('hex').slice(0, 32); }
function resolvedAddresses(message: string, projectId: string, projectSlug: string) {
	const resolved = new Map<string, { agentSlug: string; requirement: 'required' | 'optional' }>();
	for (const address of parseCommunicationAddresses(message)) {
		if (address.projectSlug && ![projectId, projectSlug].includes(address.projectSlug)) throw new CapacityOperationError(409,
			'communication_target_project_mismatch', `Agent target ${address.address} does not belong to project ${projectSlug}.`);
		const existing = resolved.get(address.agentSlug);
		if (!existing || address.requirement === 'required') resolved.set(address.agentSlug, {
			agentSlug: address.agentSlug, requirement: address.requirement,
		});
	}
	return [...resolved.values()];
}
function channelSlug(value: unknown) {
	const slug = text(value).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 72);
	if (!slug) throw new CapacityOperationError(400, 'communication_topic_invalid', 'Discussion topic must contain a letter or number.');
	return slug;
}

function requestedLimit(query: Row) {
	try { return normalizeCapacityPageLimit(query.limit); }
	catch (error) { throw new CapacityOperationError(400, 'capacity_page_invalid', error instanceof Error ? error.message : String(error)); }
}

async function invocation(store: any, teamId: string, invocationId: string) {
	const row = await store.first('SELECT * FROM agent_invocation_requests WHERE id=? AND team_id=?', [invocationId, teamId]);
	if (!row) throw new CapacityOperationError(404, 'agent_invocation_not_found', 'Agent invocation not found.');
	return row as Row;
}

export function createCommunicationService(store: any, discussions?: { create(principal: CapacityPrincipal, body: Row, idempotencyKey?: string): Promise<Row> }, contentStore: any = store) {
	async function sendReceipt(teamId: string, sendId: string, replayed = false) {
		const invocations = await store.all(`SELECT * FROM agent_invocation_requests WHERE team_id=? AND execution_kind='conversation'
			AND metadata_json::jsonb->'communication'->>'sendId'=? ORDER BY requested_at,id`, [teamId, sendId]);
		if (!invocations.length) throw new CapacityOperationError(404, 'communication_send_not_found', 'Communication send not found.');
		const assignments = await store.all(`SELECT assignment.* FROM capacity_provider_assignments assignment
			JOIN agent_invocation_requests invocation ON invocation.id=assignment.invocation_id AND invocation.team_id=assignment.team_id
			WHERE invocation.team_id=? AND invocation.execution_kind='conversation'
			AND invocation.metadata_json::jsonb->'communication'->>'sendId'=? ORDER BY assignment.updated_at DESC`, [teamId, sendId]);
		const assignmentByInvocation = new Map<string, Row>();
		for (const assignment of assignments) if (!assignmentByInvocation.has(text(assignment.invocation_id))) assignmentByInvocation.set(text(assignment.invocation_id), assignment);
		const projectId = text(invocations[0]?.project_id);
		const communication = record(record(invocations[0]?.metadata_json).communication);
		const discussionId = text(record(invocations[0]?.metadata_json).discussionId);
		const history = await loadDiscussions({ store: contentStore, projectId, discussionId, collection: 'messages', limit: 200 });
		const messages = history.messages as Row[];
		const sourceMessageId = text(record(invocations[0]?.metadata_json).sourceMessageId);
		const source = messages.find((message) => text(message.id) === sourceMessageId);
		const responses = invocations.flatMap((invocation: Row) => {
			const path = text(invocation.final_message_ref);
			const message = messages.find((candidate) => text(candidate.path) === path);
			if (!message) return [];
			const frontmatter = record(message.frontmatter);
			const outcome = text(record(invocation.response_json).outcome, 'responded');
			return [{ projectId: text(invocation.project_id), agentSlug: text(invocation.agent_id), invocationId: text(invocation.id),
				assignmentId: text(invocation.assignment_id) || null, messageRef: path, markdown: text(message.body), status: 'responded',
				requirement: text(record(record(invocation.metadata_json).communication).requirement, 'required'),
				...(outcome === 'abstained' ? { status: 'abstained' } : {}),
				createdAt: text(frontmatter.createdAt, text(invocation.completed_at, new Date().toISOString())) }];
		});
		const statuses = invocations.map((row: Row) => text(row.status));
		const finished = statuses.filter((status: string) => ['completed', 'suspended', 'failed', 'cancelled'].includes(status)).length;
		const status = finished === invocations.length
			? responses.length === invocations.length ? 'complete' : responses.length ? 'partial' : 'failed'
			: statuses.some((value: string) => ['admitted', 'running'].includes(value)) ? 'running' : 'queued';
		const project = await contentStore.getProjectDetails(projectId);
		const topic = await store.first('SELECT id,slug FROM communication_discussion_topics WHERE id=? AND team_id=? LIMIT 1', [text(communication.topicId), teamId]);
		const stream = await store.first('SELECT id,project_id FROM communication_discussion_streams WHERE id=? AND team_id=? LIMIT 1', [text(communication.streamId), teamId]);
		if (!topic || !stream) throw new CapacityOperationError(409, 'communication_topic_stream_missing', 'Communication topic stream provenance is unavailable.');
		const targetStatus = (row: Row) => text(record(row.response_json).outcome) === 'abstained' ? 'abstained'
			: text(row.final_message_ref) || text(row.status) === 'suspended' ? 'responded'
			: text(row.status) === 'failed' ? 'failed' : text(row.status) === 'cancelled' ? 'cancelled'
				: ['admitted', 'running'].includes(text(row.status)) ? 'running' : 'queued';
		return { schemaVersion: 'treeseed.communication-send-receipt/v2', sendId, teamId,
			channel: text(topic.slug), topic: { id: text(topic.id), slug: text(topic.slug) },
			projectStream: { id: text(stream.id), projectId, projectSlug: text(project?.project?.slug, projectId) },
			discussionId, messageRef: text(source?.path), sourceMessage: text(source?.body), status,
			targets: invocations.map((row: Row) => ({ projectId: text(row.project_id), projectSlug: text(project?.project?.slug, text(row.project_id)),
				agentSlug: text(row.agent_id), definitionRevision: text(row.agent_revision), revisions: {
					project: text(record(record(row.metadata_json).revisions).project, text(record(row.metadata_json).sourceCommit, text(row.agent_revision))),
					library: text(record(record(row.metadata_json).revisions).library, text(row.agent_revision)),
					agentDefinition: text(record(record(row.metadata_json).revisions).agentDefinition, text(row.agent_revision)),
					chatProfile: text(record(record(row.metadata_json).revisions).chatProfile, text(row.agent_revision)),
				}, invocationId: text(row.id) || null,
				requirement: text(record(record(row.metadata_json).communication).requirement, 'required'),
				parentInvocationId: text(row.handoff_parent_id) || null, depth: Number(row.handoff_depth ?? 0),
				status: targetStatus(row), requestedAt: text(row.requested_at), updatedAt: text(row.updated_at), completedAt: text(row.completed_at) || null,
				failure: (() => { const state = record(row.blocking_state_json); const code = text(state.code); return code ? { code, message: text(state.message, text(state.reason)) || null } : null; })(),
				capacity: (() => { const assignment = assignmentByInvocation.get(text(row.id)) ?? {}; return {
					assignmentId: text(assignment.id) || null, providerId: text(assignment.capacity_provider_id) || null,
					executionProviderId: text(assignment.execution_provider_id) || null, laneId: text(assignment.lane_id) || null,
					lanePurpose: text(assignment.lane_purpose) || null, status: text(assignment.status) || null,
					assignedAt: text(assignment.assigned_at) || null, claimedAt: text(assignment.claimed_at) || null,
					completedAt: text(assignment.completed_at) || null, returnedAt: text(assignment.returned_at) || null,
					failedAt: text(assignment.failed_at) || null,
				}; })() })),
			responses, createdAt: text(invocations[0]?.requested_at, new Date().toISOString()),
			updatedAt: text(invocations.at(-1)?.updated_at, text(invocations[0]?.requested_at, new Date().toISOString())), replayed };
	}
	return {
		async send(principal: CapacityPrincipal, teamId: string, channel: string, body: Row, idempotencyKey?: string) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:manage:team');
			if (!discussions) throw new CapacityOperationError(503, 'discussion_service_unavailable', 'Discussion service is unavailable.');
			if (!idempotencyKey) throw new CapacityOperationError(400, 'idempotency_key_required', 'Communication send requires an idempotency key.');
			const projectSelector = text(body.projectId);
			if (!projectSelector) throw new CapacityOperationError(400, 'communication_project_required', 'Select a project for unambiguous agent resolution.');
			let details = await contentStore.getProjectDetails(projectSelector);
			if (!details?.project) {
				const bySlug = typeof contentStore.getProjectByTeamAndSlug === 'function' ? await contentStore.getProjectByTeamAndSlug(teamId, projectSelector) : null;
				if (bySlug?.id) details = await contentStore.getProjectDetails(bySlug.id);
			}
			if (!details?.project || text(details.project.teamId) !== teamId) throw new CapacityOperationError(404, 'communication_project_not_found', 'Project not found in the selected team.');
			const projectId = text(details.project.id);
			const projectSlug = text(details.project.slug, projectId);
			const addresses = resolvedAddresses(text(body.message), projectId, projectSlug);
			if (!addresses.length) throw new CapacityOperationError(400, 'communication_recipient_required', 'Address at least one project agent in the message.');
			const agentSlugs = addresses.map((address) => address.agentSlug);
			const compatibility = Array.isArray(body.recipients) ? body.recipients.map(String) : [];
			for (const value of compatibility) {
				const normalized = value.replace(/^@/u, '').toLowerCase(); const agent = normalized.includes('/') ? normalized.slice(normalized.indexOf('/') + 1) : normalized;
				if (!agentSlugs.includes(agent)) throw new CapacityOperationError(400, 'communication_to_not_mentioned', `Deprecated recipient ${value} is not addressed in the message.`);
			}
			const slug = channelSlug(channel); const now = new Date().toISOString();
			const topicId = `topic-${stableId(teamId, slug)}`;
			await store.run(`INSERT INTO communication_discussion_topics (id,team_id,slug,status,created_at,updated_at) VALUES (?, ?, ?, 'active', ?, ?)
				ON CONFLICT (team_id,slug) DO NOTHING`, [topicId, teamId, slug, now, now]);
			const topic = await store.first('SELECT * FROM communication_discussion_topics WHERE team_id=? AND slug=? LIMIT 1', [teamId, slug]);
			if (!topic || text(topic.status) !== 'active') throw new CapacityOperationError(409, 'communication_topic_unavailable', 'Discussion topic is not active.');
			const streamId = `stream-${stableId(text(topic.id), projectId)}`;
			const discussionId = `discussion-${stableId(teamId, `${text(topic.id)}:${projectId}`)}`;
			await store.run(`INSERT INTO communication_discussion_streams (id,topic_id,team_id,project_id,discussion_id,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (topic_id,project_id) DO NOTHING`, [streamId, topic.id, teamId, projectId, discussionId, now, now]);
			const stream = await store.first('SELECT * FROM communication_discussion_streams WHERE topic_id=? AND project_id=? LIMIT 1', [topic.id, projectId]);
			if (!stream) throw new CapacityOperationError(503, 'communication_topic_stream_unavailable', 'Discussion topic project stream could not be established.');
			const sendId = `send-${stableId(teamId, idempotencyKey)}`;
			const sendCommunication = { channel: slug, topicId: topic.id, streamId: stream.id, sendId };
			const created = await discussions.create(principal, { teamId, projectId, discussionId: text(stream.discussion_id), createDiscussion: true,
				body: body.message, topic: slug, recipients: agentSlugs, durationSeconds: 900, communication: sendCommunication,
				addressRequirements: Object.fromEntries(addresses.map((address) => [address.agentSlug, address.requirement])) }, idempotencyKey);
			const unavailable = (Array.isArray(created.invocations) ? created.invocations : []).find((candidate: Row) => text(candidate.blocker) === 'communication_supply_unavailable');
			if (unavailable) throw new CapacityOperationError(503, 'communication_capacity_unavailable',
				'No approved healthy capacity provider with an active communication lane is available.');
			return sendReceipt(teamId, sendId, created.replayed === true);
		},
		async sendStatus(principal: CapacityPrincipal, teamId: string, sendId: string) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			return sendReceipt(teamId, sendId, false);
		},
		async invocations(principal: CapacityPrincipal, teamId: string, query: Row) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			const clauses = ['team_id=?']; const values: unknown[] = [teamId];
			for (const [field, column] of [['executionKind', 'execution_kind'], ['status', 'status']] as const) {
				if (typeof query[field] === 'string' && query[field]) { clauses.push(`${column}=?`); values.push(query[field]); }
			}
			const limit = requestedLimit(query);
			return { items: await store.all(`SELECT * FROM agent_invocation_requests WHERE ${clauses.join(' AND ')} ORDER BY requested_at DESC,id DESC LIMIT ?`, [...values, limit]), cursor: null };
		},
		async invocation(principal: CapacityPrincipal, teamId: string, invocationId: string) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			return invocation(store, teamId, invocationId);
		},
		async status(principal: CapacityPrincipal, teamId: string) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			const now = new Date().toISOString();
			const [sessions, queue, assignments] = await Promise.all([
				store.all("SELECT id,capacity_provider_id,execution_providers_json,metadata_json,refreshed_at,expires_at FROM capacity_provider_availability_sessions WHERE team_id=? AND status='open' AND expires_at>? ORDER BY refreshed_at DESC", [teamId, now]),
				store.all("SELECT status,priority_class,COUNT(*) AS count FROM agent_invocation_requests WHERE team_id=? AND execution_kind='conversation' GROUP BY status,priority_class ORDER BY status,priority_class", [teamId]),
				store.all("SELECT lane_id,lane_purpose,communication_overflow,status,COUNT(*) AS count FROM capacity_provider_assignments WHERE team_id=? AND execution_kind='conversation' GROUP BY lane_id,lane_purpose,communication_overflow,status ORDER BY lane_id,status", [teamId]),
			]);
			const providers = sessions.map(readiness);
			return { communicationReady: providers.some((entry: Row) => entry.communicationReady), providers, queue, assignments, observedAt: now };
		},
		async records(principal: CapacityPrincipal, teamId: string, table: 'agent_operation_handoffs' | 'agent_client_actions', query: Row) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			const limit = requestedLimit(query); const status = typeof query.status === 'string' ? query.status : '';
			return { items: await store.all(`SELECT * FROM ${table} WHERE team_id=? ${status ? 'AND status=?' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`, status ? [teamId, status, limit] : [teamId, limit]), cursor: null };
		},
		async cancel(principal: CapacityPrincipal, teamId: string, invocationId: string, body: Row,
			idempotencyKey?: string, ifMatch?: string) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:manage:team');
			if (!idempotencyKey) throw new CapacityOperationError(400, 'idempotency_key_required', 'Idempotency-Key is required.');
			const row = await invocation(store, teamId, invocationId);
			if (ifMatch !== String(row.updated_at ?? '')) throw new CapacityOperationError(412,
				'agent_invocation_precondition_failed', 'The agent invocation changed after it was inspected.');
			if (row.status === 'cancelled') return { ...row, replayed: true };
			if (['admitted', 'running'].includes(String(row.status))) {
				const assignment = await store.first('SELECT id,status,lifecycle_code,lifecycle_reason FROM capacity_provider_assignments WHERE team_id=? AND invocation_id=? ORDER BY updated_at DESC LIMIT 1', [teamId, invocationId]);
				if (assignment && terminal(assignment.status)) {
					const integrated = assignment.status === 'completed' ? await store.first("SELECT id FROM audit_events WHERE target_type='capacity_provider_assignment' AND target_id=? AND event_type='assignment.content.integrated' LIMIT 1", [assignment.id]) : null;
					const successful = assignment.status === 'completed' && Boolean(String(row.final_message_ref ?? '').trim()) && Boolean(integrated);
					if (assignment.status === 'completed' && !successful) throw new CapacityOperationError(409,
						'conversation_content_integration_pending', 'The final response and operational content are not integrated.');
					const now = new Date().toISOString();
					await store.run("UPDATE agent_invocation_requests SET status=?,assignment_id=?,completed_at=COALESCE(completed_at,?),blocking_state_json=?,updated_at=? WHERE id=? AND team_id=? AND updated_at=? AND status IN ('admitted','running')", [successful ? 'completed' : 'failed', assignment.id, now, JSON.stringify({ code: successful ? 'durable_final_response' : 'terminal_assignment_without_final_response', assignmentStatus: assignment.status, lifecycleCode: assignment.lifecycle_code ?? null, lifecycleReason: assignment.lifecycle_reason ?? null, reconciledBy: idempotencyKey }), now, invocationId, teamId, ifMatch]);
					return { ...(await invocation(store, teamId, invocationId)), reconciled: true };
				}
				if (!assignment && row.execution_id) {
					const execution = await store.first('SELECT id,status,error_json FROM capacity_workday_runs WHERE id=? AND team_id=?', [row.execution_id, teamId]);
					if (execution && ['completed', 'failed', 'degraded', 'cancelled'].includes(String(execution.status))) {
						const now = new Date().toISOString();
						await store.run("UPDATE agent_invocation_requests SET status='failed',completed_at=COALESCE(completed_at,?),blocking_state_json=?,updated_at=? WHERE id=? AND team_id=? AND updated_at=? AND status IN ('admitted','running')", [now, JSON.stringify({ code: 'terminal_execution_without_assignment', executionId: execution.id, executionStatus: execution.status, executionError: execution.error_json ?? null, reconciledBy: idempotencyKey }), now, invocationId, teamId, ifMatch]);
						return { ...(await invocation(store, teamId, invocationId)), reconciled: true };
					}
				}
			}
			if (!['queued', 'blocked', 'coalesced'].includes(String(row.status))) throw new CapacityOperationError(409,
				'agent_invocation_not_cancellable', 'Only an unadmitted invocation can be cancelled directly.');
			const now = new Date().toISOString();
			await store.run("UPDATE agent_invocation_requests SET status='cancelled',completed_at=?,blocking_state_json=?,updated_at=? WHERE id=? AND team_id=? AND updated_at=? AND status IN ('queued','blocked','coalesced')", [now, JSON.stringify({ code: 'operator_cancelled', idempotencyKey, reason: body.reason ?? null }), now, invocationId, teamId, ifMatch]);
			const updated = await invocation(store, teamId, invocationId);
			if (updated.status !== 'cancelled') throw new CapacityOperationError(412, 'agent_invocation_precondition_failed', 'The agent invocation changed concurrently.');
			return updated;
		},
	};
}
