import { normalizeCapacityPageLimit } from '@treeseed/sdk/capacity-pagination';
import { parseCommunicationAddresses } from '@treeseed/sdk/operator-contracts';
import { createHash } from 'node:crypto';
import { authorizeCapacityTeam, type CapacityPrincipal } from './capacity-authorization.ts';
import { CapacityOperationError } from './capacity-operation-error.ts';
import { loadDiscussions } from '../../../discussions/content.ts';
import { resolveTeamCommunicationTargets } from '../../../capacity/services/capacity/invocations/communication-target-resolution.ts';
import { reconcileBlockedDiscussionInvocations } from '../../../capacity/services/capacity/invocations/discussion-invocation-service.ts';
import type { DiagnosticEnvelopeService } from '../../../security/diagnostic-envelope.ts';

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
function strings(value: unknown): string[] {
	if (Array.isArray(value)) return value.map(String).map((entry) => entry.trim()).filter(Boolean);
	if (typeof value === 'string') try { return strings(JSON.parse(value)); } catch { return []; }
	return [];
}
function timestamp(value: unknown, fallback = '') {
	if (value instanceof Date) return value.toISOString();
	const candidate = text(value);
	if (!candidate) return fallback;
	const milliseconds = Date.parse(candidate);
	return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : fallback;
}
function stableId(scope: string, value: string) { return createHash('sha256').update(`${scope}:${value}`).digest('hex').slice(0, 32); }
function channelSlug(value: unknown) {
	const slug = text(value).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 72);
	if (!slug) throw new CapacityOperationError(400, 'communication_topic_invalid', 'Discussion topic must contain a letter or number.');
	return slug;
}

function requestedLimit(query: Row) {
	try { return normalizeCapacityPageLimit(query.limit); }
	catch (error) { throw new CapacityOperationError(400, 'capacity_page_invalid', error instanceof Error ? error.message : String(error)); }
}

function eventRow(row: Row, channel: string) {
	return { id: text(row.id), sequence: Number(row.sequence), teamId: text(row.team_id), topicId: text(row.topic_id), channel,
		type: text(row.event_type), occurredAt: timestamp(row.occurred_at), sendId: text(row.send_id) || null,
		invocationId: text(row.invocation_id) || null, assignmentId: text(row.assignment_id) || null,
		actor: { kind: text(row.actor_kind), id: text(row.actor_id), handle: text(row.actor_handle) || null },
		summary: text(row.summary), payload: record(row.payload_json) };
}

async function invocation(store: any, teamId: string, invocationId: string) {
	const row = await store.first('SELECT * FROM agent_invocation_requests WHERE id=? AND team_id=?', [invocationId, teamId]);
	if (!row) throw new CapacityOperationError(404, 'agent_invocation_not_found', 'Agent invocation not found.');
	return row as Row;
}

export function createCommunicationService(store: any, discussions?: { create(principal: CapacityPrincipal, body: Row, idempotencyKey?: string): Promise<Row> }, contentStore: any = store, diagnosticEnvelopes?: DiagnosticEnvelopeService) {
	async function topicView(teamId: string, topic: Row) {
		const streams = await store.all('SELECT * FROM communication_discussion_streams WHERE team_id=? AND topic_id=? ORDER BY project_id', [teamId, topic.id]);
		const subscriptions = await store.all("SELECT * FROM communication_topic_subscriptions WHERE team_id=? AND topic_id=? AND status='active' ORDER BY project_id,agent_slug", [teamId, topic.id]);
		const projectIds = [...new Set([...streams, ...subscriptions].map((row: Row) => text(row.project_id)).filter(Boolean))];
		const slugs = new Map<string, string>();
		for (const projectId of projectIds) slugs.set(projectId, text((await contentStore.getProjectDetails(projectId))?.project?.slug, projectId));
		return { id: text(topic.id), teamId, slug: text(topic.slug), status: text(topic.status, 'active'), createdAt: timestamp(topic.created_at), updatedAt: timestamp(topic.updated_at),
			streams: streams.map((row: Row) => ({ id: text(row.id), projectId: text(row.project_id), projectSlug: slugs.get(text(row.project_id)) ?? text(row.project_id), discussionId: text(row.discussion_id) })),
			listeners: subscriptions.map((row: Row) => ({ projectId: text(row.project_id), projectSlug: slugs.get(text(row.project_id)) ?? text(row.project_id), agentSlug: text(row.agent_slug),
				agentHandle: `@${slugs.get(text(row.project_id)) ?? text(row.project_id)}/${text(row.agent_slug)}`, status: text(row.status, 'active'), source: text(row.source, 'mention'),
				subscribedAt: timestamp(row.subscribed_at), updatedAt: timestamp(row.updated_at) })),
		};
	}

	async function appendTopicEvent(input: { topic: Row; teamId: string; type: string; sendId?: string; invocationId?: string; assignmentId?: string; actorKind: string; actorId: string; actorHandle?: string; summary: string; payload?: Row; idempotency: string; occurredAt?: string }) {
		const id = `topic-event-${stableId(text(input.topic.id), input.idempotency)}`, occurredAt = input.occurredAt ?? new Date().toISOString();
		await store.run(`INSERT INTO communication_topic_events (id,topic_id,team_id,event_type,occurred_at,send_id,invocation_id,assignment_id,actor_kind,actor_id,actor_handle,summary,payload_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb) ON CONFLICT (id) DO NOTHING`, [id, input.topic.id, input.teamId, input.type, occurredAt, input.sendId ?? null,
			input.invocationId ?? null, input.assignmentId ?? null, input.actorKind, input.actorId, input.actorHandle ?? null, input.summary, JSON.stringify(input.payload ?? {})]);
		return store.first('SELECT * FROM communication_topic_events WHERE id=?', [id]);
	}

	async function reconcileTopicHistory(teamId: string, topic: Row) {
		const streams = await store.all('SELECT * FROM communication_discussion_streams WHERE team_id=? AND topic_id=? ORDER BY project_id', [teamId, topic.id]);
		if (!streams.length) return;
		const existing = await store.all('SELECT payload_json FROM communication_topic_events WHERE team_id=? AND topic_id=?', [teamId, topic.id]);
		const knownRefs = new Set<string>();
		for (const row of existing) {
			const payload = record(row.payload_json);
			if (text(payload.messageRef)) knownRefs.add(text(payload.messageRef));
			for (const ref of Array.isArray(payload.messageRefs) ? payload.messageRefs : []) if (text(ref)) knownRefs.add(text(ref));
		}
		const pending: Array<{ stream: Row; projectSlug: string; message: Row; frontmatter: Row }> = [];
		for (const stream of streams) {
			const projectId = text(stream.project_id), projectSlug = text((await contentStore.getProjectDetails(projectId))?.project?.slug, projectId);
			const history = await loadDiscussions({ store: contentStore, projectId, discussionId: text(stream.discussion_id), collection: 'messages', limit: 100 }).catch(() => ({ messages: [] }));
			for (const message of history.messages as Row[]) {
				const frontmatter = record(message.frontmatter);
				if (text(frontmatter.authorType) === 'agent') {
					const agentSlug = text(frontmatter.authorAgentId, text(frontmatter.authorId));
					if (agentSlug) {
						const now = text(frontmatter.createdAt, new Date().toISOString()), subscriptionId = `subscription-${stableId(text(topic.id), `${projectId}:${agentSlug}`)}`;
						await store.run(`INSERT INTO communication_topic_subscriptions (id,topic_id,team_id,project_id,agent_slug,status,source,subscribed_at,updated_at)
							VALUES (?, ?, ?, ?, ?, 'active', 'mention', ?, ?) ON CONFLICT (topic_id,project_id,agent_slug) DO UPDATE SET status='active',updated_at=EXCLUDED.updated_at`,
							[subscriptionId, topic.id, teamId, projectId, agentSlug, now, now]);
					}
				}
				if (!knownRefs.has(text(message.path))) pending.push({ stream, projectSlug, message, frontmatter });
			}
		}
		pending.sort((left, right) => text(left.frontmatter.createdAt).localeCompare(text(right.frontmatter.createdAt)));
		const userMessages = new Set<string>();
		for (const entry of pending) {
			const path = text(entry.message.path); if (!path) continue;
			const authorType = text(entry.frontmatter.authorType, 'user'), createdAt = text(entry.frontmatter.createdAt, new Date().toISOString());
			const logicalUserMessage = authorType === 'user' ? stableId('discussion-message', `${createdAt.slice(0, 19)}:${text(entry.message.body)}`) : path;
			if (authorType === 'user' && userMessages.has(logicalUserMessage)) continue;
			userMessages.add(logicalUserMessage);
			const authorAgent = text(entry.frontmatter.authorAgentId, text(entry.frontmatter.authorId, 'agent'));
			await appendTopicEvent({ topic, teamId, type: authorType === 'agent' ? 'agent.response' : 'message.posted',
				actorKind: authorType === 'agent' ? 'agent' : 'user', actorId: text(entry.frontmatter.authorId, authorType),
				actorHandle: authorType === 'agent' ? `@${entry.projectSlug}/${authorAgent}` : undefined,
				summary: authorType === 'agent' ? 'Agent response restored from TreeDX.' : 'Discussion message restored from TreeDX.',
				payload: authorType === 'agent' ? { messageRef: path, markdown: text(entry.message.body) } : { messageRefs: [path], markdown: text(entry.message.body) },
				idempotency: `treedx-history:${path}`, occurredAt: createdAt });
		}
	}

	async function reconcileTopicAssignmentEvents(teamId: string, topic: Row) {
		const rows = await store.all(`SELECT invocation.id AS invocation_id,invocation.agent_id,invocation.project_id,
			assignment.id AS assignment_id,assignment.capacity_provider_id,assignment.claimed_at
			FROM agent_invocation_requests invocation
			JOIN capacity_provider_assignments assignment ON assignment.invocation_id=invocation.id AND assignment.team_id=invocation.team_id
			WHERE invocation.team_id=? AND invocation.execution_kind='conversation'
			AND invocation.metadata_json::jsonb->'communication'->>'topicId'=? AND assignment.claimed_at IS NOT NULL
			AND NOT EXISTS (SELECT 1 FROM agent_invocation_requests newer
				WHERE newer.team_id=invocation.team_id AND newer.project_id=invocation.project_id AND newer.agent_id=invocation.agent_id
				AND newer.execution_kind='conversation' AND newer.metadata_json::jsonb->'communication'->>'topicId'=?
				AND newer.requested_at>invocation.requested_at)
			ORDER BY assignment.created_at`, [teamId, topic.id, topic.id]);
		for (const row of rows) {
			const project = await contentStore.getProjectDetails(text(row.project_id));
			const handle = `@${text(project?.project?.slug, text(row.project_id))}/${text(row.agent_id, 'agent')}`;
			const occurredAt = timestamp(row.claimed_at, new Date().toISOString());
			await appendTopicEvent({ topic, teamId, type: 'mention.acknowledged', invocationId: text(row.invocation_id), assignmentId: text(row.assignment_id),
				actorKind: 'provider', actorId: text(row.capacity_provider_id, 'provider'), actorHandle: handle,
				summary: 'Mention acknowledged by the execution provider.', payload: { reconciledFrom: 'assignment_claim' },
				idempotency: `${text(row.assignment_id)}:mention.acknowledged`, occurredAt });
			await appendTopicEvent({ topic, teamId, type: 'response_lease.accepted', invocationId: text(row.invocation_id), assignmentId: text(row.assignment_id),
				actorKind: 'provider', actorId: text(row.capacity_provider_id, 'provider'), actorHandle: handle,
				summary: 'Response lease accepted; execution is starting.', payload: { reconciledFrom: 'assignment_claim' },
				idempotency: `${text(row.assignment_id)}:response_lease.accepted`, occurredAt });
		}
	}

	async function diagnosticsFor(assignment: Row, invocation: Row, full: boolean) {
		await store.run(`UPDATE communication_execution_trace_events SET protected_payload_json=NULL,protected_payload_envelope_json=NULL
			WHERE assignment_id=? AND protected_payload_expires_at IS NOT NULL AND protected_payload_expires_at<=?`, [assignment.id, new Date().toISOString()]);
		const traces = text(assignment.id) ? await store.all('SELECT * FROM communication_execution_trace_events WHERE assignment_id=? ORDER BY sequence', [assignment.id]) : [];
		const metadata = record(invocation.metadata_json); const capacity = record(assignment.capacity_envelope_json);
		const traceEvents = traces.map((trace: Row) => ({ sequence: Number(trace.sequence), type: text(trace.event_type), occurredAt: timestamp(trace.occurred_at), summary: text(trace.summary), payload: record(trace.payload_json),
			...(full && trace.protected_payload_envelope_json ? { protectedPayload: diagnosticEnvelopes?.decrypt(record(trace.protected_payload_envelope_json)) ?? { unavailable: 'diagnostics_encryption_key_unavailable' } }
				: {}) }));
		const started = traceEvents.find((event) => event.type === 'execution.started'); const startedPayload = record(started?.payload);
		const terminal = [...traceEvents].reverse().find((event) => event.type === 'execution.completed'); const terminalPayload = record(terminal?.payload);
		return { availability: traces.length ? 'available' : 'unavailable', reason: traces.length ? null : 'provider_trace_unavailable',
			provider: { providerId: text(assignment.capacity_provider_id) || null, executionProviderId: text(assignment.execution_provider_id) || null, runtimeVersion: text(terminalPayload.runtimeVersion) || null },
			selection: { model: text(terminalPayload.model) || null, capabilities: Array.isArray(terminalPayload.capabilities) ? terminalPayload.capabilities.map(String) : [], parameters: record(terminalPayload.parameters ?? capacity) },
			identityManifest: record(startedPayload.identityManifest ?? metadata.identityManifest), contextManifest: Array.isArray(startedPayload.contextManifest)
				? startedPayload.contextManifest.map(record) : Array.isArray(metadata.contextManifest) ? metadata.contextManifest.map(record) : [],
			usage: Array.isArray(terminalPayload.usage) ? terminalPayload.usage.map(record) : [], timing: record(terminalPayload.timing), resources: record(terminalPayload.resources), traceEvents,
			...(full ? { fullPayload: { events: traceEvents } } : {}) };
	}

	async function sendReceipt(teamId: string, sendId: string, replayed = false, diagnostics: 'metadata' | 'full' = 'metadata') {
		const invocations = await store.all(`SELECT * FROM agent_invocation_requests WHERE team_id=? AND execution_kind='conversation'
			AND metadata_json::jsonb->'communication'->>'sendId'=? ORDER BY requested_at,id`, [teamId, sendId]);
		if (!invocations.length) throw new CapacityOperationError(404, 'communication_send_not_found', 'Communication send not found.');
		const assignments = await store.all(`SELECT assignment.* FROM capacity_provider_assignments assignment
			JOIN agent_invocation_requests invocation ON invocation.id=assignment.invocation_id AND invocation.team_id=assignment.team_id
			WHERE invocation.team_id=? AND invocation.execution_kind='conversation'
			AND invocation.metadata_json::jsonb->'communication'->>'sendId'=? ORDER BY assignment.updated_at DESC`, [teamId, sendId]);
		const assignmentByInvocation = new Map<string, Row>();
		for (const assignment of assignments) if (!assignmentByInvocation.has(text(assignment.invocation_id))) assignmentByInvocation.set(text(assignment.invocation_id), assignment);
		const projectIds = [...new Set(invocations.map((row: Row) => text(row.project_id)))];
		const projects = new Map<string, { slug: string; discussionId: string; messages: Row[]; source: Row | undefined; topic: Row; stream: Row }>();
		for (const projectId of projectIds) {
			const invocation = invocations.find((row: Row) => text(row.project_id) === projectId)!;
			const metadata = record(invocation.metadata_json); const communication = record(metadata.communication);
			const discussionId = text(metadata.discussionId); const details = await contentStore.getProjectDetails(projectId);
			const exactPaths = [...new Set(invocations.filter((row: Row) => text(row.project_id) === projectId).flatMap((row: Row) => [
				strings(row.content_refs_json)[0], text(row.final_message_ref),
			]).filter(Boolean))];
			const history = await loadDiscussions({ store: contentStore, projectId, discussionId,
				exactPaths, collection: 'messages', limit: Math.max(1, exactPaths.length) });
			const messages = history.messages as Row[]; const sourceMessageId = text(metadata.sourceMessageId);
			const topic = await store.first('SELECT id,slug FROM communication_discussion_topics WHERE id=? AND team_id=? LIMIT 1', [text(communication.topicId), teamId]);
			const stream = await store.first('SELECT id,project_id FROM communication_discussion_streams WHERE id=? AND team_id=? LIMIT 1', [text(communication.streamId), teamId]);
			if (!topic || !stream) throw new CapacityOperationError(409, 'communication_topic_stream_missing', 'Communication topic stream provenance is unavailable.');
			projects.set(projectId, { slug: text(details?.project?.slug, projectId), discussionId, messages,
				source: messages.find((message) => text(message.id) === sourceMessageId), topic, stream });
		}
		const first = projects.get(projectIds[0]!)!;
		const eventRows = await store.all('SELECT * FROM communication_topic_events WHERE team_id=? AND topic_id=? AND send_id=? ORDER BY sequence', [teamId, first.topic.id, sendId]);
		const responses = invocations.flatMap((invocation: Row) => {
			const path = text(invocation.final_message_ref);
			const message = projects.get(text(invocation.project_id))?.messages.find((candidate) => text(candidate.path) === path);
			const projected = eventRows.find((candidate: Row) => text(candidate.invocation_id) === text(invocation.id)
				&& text(candidate.event_type) === 'agent.response' && text(record(candidate.payload_json).messageRef) === path);
			if (!message && !projected) return [];
			const frontmatter = record(message?.frontmatter), projectedPayload = record(projected?.payload_json);
			const outcome = text(record(invocation.response_json).outcome, 'responded');
			return [{ projectId: text(invocation.project_id), projectSlug: projects.get(text(invocation.project_id))?.slug ?? text(invocation.project_id),
				agentSlug: text(invocation.agent_id), invocationId: text(invocation.id),
				assignmentId: text(invocation.assignment_id) || null, messageRef: path, markdown: text(message?.body, text(projectedPayload.markdown)), status: 'responded',
				requirement: text(record(record(invocation.metadata_json).communication).requirement, 'required'),
				...(outcome === 'abstained' ? { status: 'abstained' } : {}),
				createdAt: text(frontmatter.createdAt, timestamp(projected?.occurred_at, timestamp(invocation.completed_at, new Date().toISOString()))) }];
		});
		const statuses = invocations.map((row: Row) => text(row.status));
		const finished = statuses.filter((status: string) => ['completed', 'suspended', 'failed', 'cancelled'].includes(status)).length;
		const status = finished === invocations.length
			? responses.length === invocations.length ? 'complete' : responses.length ? 'partial' : 'failed'
			: statuses.some((value: string) => ['admitted', 'running'].includes(value)) ? 'running' : 'queued';
		const targetStatus = (row: Row) => text(record(row.response_json).outcome) === 'abstained' ? 'abstained'
			: text(row.final_message_ref) || text(row.status) === 'suspended' ? 'responded'
			: text(row.status) === 'failed' ? 'failed' : text(row.status) === 'cancelled' ? 'cancelled'
				: ['admitted', 'running'].includes(text(row.status)) ? 'running' : 'queued';
		const targets = await Promise.all(invocations.map(async (row: Row) => { const assignment = assignmentByInvocation.get(text(row.id)) ?? {}; return ({ projectId: text(row.project_id), projectSlug: projects.get(text(row.project_id))?.slug ?? text(row.project_id),
			agentSlug: text(row.agent_id), definitionRevision: text(row.agent_revision), revisions: {
				project: text(record(record(row.metadata_json).revisions).project, text(record(row.metadata_json).sourceCommit, text(row.agent_revision))),
				library: text(record(record(row.metadata_json).revisions).library, text(row.agent_revision)),
				agentDefinition: text(record(record(row.metadata_json).revisions).agentDefinition, text(row.agent_revision)),
				chatProfile: text(record(record(row.metadata_json).revisions).chatProfile, text(row.agent_revision)),
			}, invocationId: text(row.id) || null, requirement: text(record(record(row.metadata_json).communication).requirement, 'required'),
			parentInvocationId: text(row.handoff_parent_id) || null, depth: Number(row.handoff_depth ?? 0), status: targetStatus(row), requestedAt: timestamp(row.requested_at), updatedAt: timestamp(row.updated_at), completedAt: timestamp(row.completed_at) || null,
			failure: (() => { const state = record(row.blocking_state_json); const code = text(state.code); return code ? { code, message: text(state.message, text(state.reason)) || null } : null; })(),
			capacity: { assignmentId: text(assignment.id) || null, providerId: text(assignment.capacity_provider_id) || null, executionProviderId: text(assignment.execution_provider_id) || null,
				laneId: text(assignment.lane_id) || null, lanePurpose: text(assignment.lane_purpose) || null, status: text(assignment.status) || null, assignedAt: timestamp(assignment.assigned_at) || null,
				claimedAt: timestamp(assignment.claimed_at) || null, completedAt: timestamp(assignment.completed_at) || null, returnedAt: timestamp(assignment.returned_at) || null, failedAt: timestamp(assignment.failed_at) || null },
			acknowledgedAt: timestamp(assignment.communication_acknowledged_at) || null, leaseAcceptedAt: timestamp(assignment.communication_lease_accepted_at) || null,
			diagnostics: await diagnosticsFor(assignment, row, diagnostics === 'full'),
		}); }));
		return { schemaVersion: 'treeseed.communication-send-receipt/v4', sendId, teamId,
			channel: text(first.topic.slug), topic: { id: text(first.topic.id), slug: text(first.topic.slug) },
			projectStreams: projectIds.map((projectId) => { const project = projects.get(projectId)!; return {
				id: text(project.stream.id), projectId, projectSlug: project.slug, discussionId: project.discussionId,
				messageRef: text(project.source?.path, strings(invocations.find((row: Row) => text(row.project_id) === projectId)?.content_refs_json)[0]),
			}; }), status,
			targets, responses, events: eventRows.map((row: Row) => eventRow(row, text(first.topic.slug))), createdAt: timestamp(invocations[0]?.requested_at, new Date().toISOString()),
			updatedAt: timestamp(invocations.at(-1)?.updated_at, timestamp(invocations[0]?.requested_at, new Date().toISOString())), replayed };
	}
	return {
		async send(principal: CapacityPrincipal, teamId: string, channel: string, body: Row, idempotencyKey?: string) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:manage:team');
			if (!discussions) throw new CapacityOperationError(503, 'discussion_service_unavailable', 'Discussion service is unavailable.');
			if (!idempotencyKey) throw new CapacityOperationError(400, 'idempotency_key_required', 'Communication send requires an idempotency key.');
			const explicit = parseCommunicationAddresses(text(body.message));
			const recipientAddresses = Array.isArray(body.recipients) ? parseCommunicationAddresses(body.recipients.map(String).join(' ')) : [];
			const parsed = explicit.length ? explicit : recipientAddresses;
			if (!parsed.length) throw new CapacityOperationError(400, 'communication_recipient_required', 'Address at least one team agent in the message.');
			const targets = await resolveTeamCommunicationTargets(contentStore, teamId, parsed);
			const compatibility = Array.isArray(body.recipients) ? body.recipients.map(String) : [];
			for (const value of explicit.length ? compatibility : []) {
				const normalized = value.replace(/^@/u, '').toLowerCase();
				if (!targets.some((target) => [target.agentSlug, `${target.projectSlug}/${target.agentSlug}`].includes(normalized))) throw new CapacityOperationError(400, 'communication_to_not_mentioned', `Deprecated recipient ${value} is not addressed in the message.`);
			}
			const slug = channelSlug(channel); const now = new Date().toISOString();
			const topicId = `topic-${stableId(teamId, slug)}`;
			await store.run(`INSERT INTO communication_discussion_topics (id,team_id,slug,status,created_at,updated_at) VALUES (?, ?, ?, 'active', ?, ?)
				ON CONFLICT (team_id,slug) DO NOTHING`, [topicId, teamId, slug, now, now]);
			const topic = await store.first('SELECT * FROM communication_discussion_topics WHERE team_id=? AND slug=? LIMIT 1', [teamId, slug]);
			if (!topic || text(topic.status) !== 'active') throw new CapacityOperationError(409, 'communication_topic_unavailable', 'Discussion topic is not active.');
			const sendId = `send-${stableId(teamId, idempotencyKey)}`;
			const created: Row[] = [];
			for (const projectId of [...new Set(targets.map((target) => target.projectId))]) {
				const projectTargets = targets.filter((target) => target.projectId === projectId);
				const streamId = `stream-${stableId(text(topic.id), projectId)}`;
				const discussionId = `discussion-${stableId(teamId, `${text(topic.id)}:${projectId}`)}`;
				await store.run(`INSERT INTO communication_discussion_streams (id,topic_id,team_id,project_id,discussion_id,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT (topic_id,project_id) DO NOTHING`, [streamId, topic.id, teamId, projectId, discussionId, now, now]);
				const stream = await store.first('SELECT * FROM communication_discussion_streams WHERE topic_id=? AND project_id=? LIMIT 1', [topic.id, projectId]);
				if (!stream) throw new CapacityOperationError(503, 'communication_topic_stream_unavailable', 'Discussion topic project stream could not be established.');
				const communication = { channel: slug, topicId: topic.id, streamId: stream.id, sendId };
				created.push(await discussions.create(principal, { teamId, projectId, discussionId: text(stream.discussion_id), createDiscussion: true,
					body: body.message, topic: slug, recipients: projectTargets.map((target) => target.agentSlug), durationSeconds: 60, communication,
					addressRequirements: Object.fromEntries(projectTargets.map((target) => [target.agentSlug, target.requirement])) }, `${idempotencyKey}:${projectId}`));
			}
			for (const target of targets) {
				const subscriptionId = `subscription-${stableId(text(topic.id), `${target.projectId}:${target.agentSlug}`)}`;
				await store.run(`INSERT INTO communication_topic_subscriptions (id,topic_id,team_id,project_id,agent_slug,status,source,subscribed_at,updated_at)
					VALUES (?, ?, ?, ?, ?, 'active', 'mention', ?, ?) ON CONFLICT (topic_id,project_id,agent_slug) DO UPDATE SET status='active',updated_at=EXCLUDED.updated_at`,
					[subscriptionId, topic.id, teamId, target.projectId, target.agentSlug, now, now]);
			}
			await appendTopicEvent({ topic, teamId, type: 'message.posted', sendId, actorKind: 'user', actorId: principal?.id ?? 'unknown', summary: 'Discussion message posted.',
				payload: { messageRefs: created.map((entry: Row) => record(entry.message).path).filter(Boolean), markdown: text(body.message), targets: targets.map((target) => `@${target.projectSlug}/${target.agentSlug}`) }, idempotency: `${sendId}:message.posted` });
			await store.run('UPDATE communication_discussion_topics SET updated_at=? WHERE id=?', [now, topic.id]);
			await store.run('UPDATE communication_discussion_streams SET updated_at=? WHERE topic_id=?', [now, topic.id]);
			// The message and invocation are durable at this point. Capacity may be
			// reconciled immediately after discussion creation, so a creation-time
			// blocker must remain receipt state rather than turning an accepted send
			// into a false HTTP failure.
			return sendReceipt(teamId, sendId, created.every((entry: Row) => entry.replayed === true));
		},
		async sendStatus(principal: CapacityPrincipal, teamId: string, sendId: string, query: Row = {}) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			const diagnostics = query.diagnostics === 'full' ? 'full' : 'metadata';
			if (diagnostics === 'full') await authorizeCapacityTeam(store, principal, teamId, 'agents:diagnostics:team');
			return sendReceipt(teamId, sendId, false, diagnostics);
		},
		async topics(principal: CapacityPrincipal, teamId: string, query: Row) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team'); const limit = requestedLimit(query); const status = text(query.status);
			const rows = await store.all(`SELECT * FROM communication_discussion_topics WHERE team_id=? ${status ? 'AND status=?' : ''} ORDER BY updated_at DESC,id DESC LIMIT ?`, status ? [teamId, status, limit] : [teamId, limit]);
			return { items: await Promise.all(rows.map((row: Row) => topicView(teamId, row))), cursor: null };
		},
		async topic(principal: CapacityPrincipal, teamId: string, channel: string) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team'); const topic = await store.first('SELECT * FROM communication_discussion_topics WHERE team_id=? AND slug=? LIMIT 1', [teamId, channelSlug(channel)]);
			if (!topic) throw new CapacityOperationError(404, 'communication_topic_not_found', 'Discussion topic not found.'); return topicView(teamId, topic);
		},
		async timeline(principal: CapacityPrincipal, teamId: string, channel: string, query: Row) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team'); if (query.diagnostics === 'full') await authorizeCapacityTeam(store, principal, teamId, 'agents:diagnostics:team');
			const topic = await store.first('SELECT * FROM communication_discussion_topics WHERE team_id=? AND slug=? LIMIT 1', [teamId, channelSlug(channel)]);
			if (!topic) throw new CapacityOperationError(404, 'communication_topic_not_found', 'Discussion topic not found.');
			// A connected chat must keep its own delivery queue moving even when a provider
			// runner is temporarily attached through another API generation.
			await reconcileBlockedDiscussionInvocations(store, teamId);
			const after = Math.max(0, Number(query.after) || 0), limit = Math.max(1, Math.min(500, Number(query.limit) || 200));
			await reconcileTopicAssignmentEvents(teamId, topic);
			await reconcileTopicHistory(teamId, topic);
			const deadline = Date.now() + Math.max(0, Math.min(30, Number(query.waitSeconds) || 0)) * 1_000; let rows: Row[] = [];
			do { rows = await store.all('SELECT * FROM communication_topic_events WHERE team_id=? AND topic_id=? AND sequence>? ORDER BY sequence LIMIT ?', [teamId, topic.id, after, limit]);
				if (rows.length || Date.now() >= deadline) break; await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
			} while (Date.now() < deadline);
			return { topic: await topicView(teamId, topic), events: rows.map((row: Row) => eventRow(row, text(topic.slug))), cursor: rows.length ? String(rows.at(-1)?.sequence) : String(after) };
		},
		async subscribe(principal: CapacityPrincipal, teamId: string, channel: string, body: Row) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:manage:team'); const parsed = parseCommunicationAddresses(text(body.agent));
			if (parsed.length !== 1 || !parsed[0]?.projectSlug) throw new CapacityOperationError(400, 'communication_subscription_agent_invalid', 'Subscription requires one @project/agent handle.');
			const target = (await resolveTeamCommunicationTargets(contentStore, teamId, parsed))[0]; if (!target) throw new CapacityOperationError(404, 'communication_agent_not_found', 'Agent not found.');
			const topic = await store.first('SELECT * FROM communication_discussion_topics WHERE team_id=? AND slug=? LIMIT 1', [teamId, channelSlug(channel)]); if (!topic) throw new CapacityOperationError(404, 'communication_topic_not_found', 'Discussion topic not found.');
			const now = new Date().toISOString(), id = `subscription-${stableId(text(topic.id), `${target.projectId}:${target.agentSlug}`)}`;
			const existing = await store.first('SELECT status FROM communication_topic_subscriptions WHERE id=?', [id]);
			await store.run(`INSERT INTO communication_topic_subscriptions (id,topic_id,team_id,project_id,agent_slug,status,source,subscribed_at,updated_at) VALUES (?, ?, ?, ?, ?, 'active', 'operator', ?, ?)
				ON CONFLICT (topic_id,project_id,agent_slug) DO UPDATE SET status='active',source='operator',updated_at=EXCLUDED.updated_at`, [id, topic.id, teamId, target.projectId, target.agentSlug, now, now]);
			const view = await topicView(teamId, topic); return { topicId: topic.id, listener: view.listeners.find((listener: Row) => listener.projectId === target.projectId && listener.agentSlug === target.agentSlug), replayed: text(existing?.status) === 'active' };
		},
		async unsubscribe(principal: CapacityPrincipal, teamId: string, channel: string, body: Row) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:manage:team'); const topic = await store.first('SELECT * FROM communication_discussion_topics WHERE team_id=? AND slug=? LIMIT 1', [teamId, channelSlug(channel)]); if (!topic) throw new CapacityOperationError(404, 'communication_topic_not_found', 'Discussion topic not found.');
			const parsed = parseCommunicationAddresses(text(body.agent)); if (parsed.length !== 1 || !parsed[0]?.projectSlug) throw new CapacityOperationError(400, 'communication_subscription_agent_invalid', 'Subscription removal requires one @project/agent handle.');
			const target = (await resolveTeamCommunicationTargets(contentStore, teamId, parsed))[0]; if (!target) throw new CapacityOperationError(404, 'communication_agent_not_found', 'Agent not found.');
			const { projectId, agentSlug } = target;
			const row = await store.first('SELECT * FROM communication_topic_subscriptions WHERE topic_id=? AND project_id=? AND agent_slug=? LIMIT 1', [topic.id, projectId, agentSlug]); if (!row) throw new CapacityOperationError(404, 'communication_subscription_not_found', 'Agent subscription not found.');
			const now = new Date().toISOString(); await store.run("UPDATE communication_topic_subscriptions SET status='removed',updated_at=? WHERE id=?", [now, row.id]);
			const details = await contentStore.getProjectDetails(projectId); return { topicId: topic.id, listener: { projectId, projectSlug: text(details?.project?.slug, projectId), agentSlug,
				agentHandle: `@${text(details?.project?.slug, projectId)}/${agentSlug}`, status: 'removed', source: text(row.source, 'operator'), subscribedAt: timestamp(row.subscribed_at), updatedAt: now }, replayed: text(row.status) === 'removed' };
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
