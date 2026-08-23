import { normalizeCapacityPageLimit } from '@treeseed/sdk/capacity-pagination';
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
	async function sendReceipt(teamId: string, discussionId: string) {
		const invocations = await store.all(`SELECT * FROM agent_invocation_requests WHERE team_id=? AND execution_kind='conversation'
			AND metadata_json->>'discussionId'=? ORDER BY requested_at,id`, [teamId, discussionId]);
		if (!invocations.length) throw new CapacityOperationError(404, 'communication_send_not_found', 'Communication send not found.');
		const projectId = text(invocations[0]?.project_id);
		const history = await loadDiscussions({ store: contentStore, projectId, discussionId, collection: 'messages', limit: 200 });
		const messages = history.messages as Row[];
		const sourceMessageId = text(record(invocations[0]?.metadata_json).sourceMessageId);
		const source = messages.find((message) => text(message.id) === sourceMessageId);
		const responses = invocations.flatMap((invocation: Row) => {
			const path = text(invocation.final_message_ref);
			const message = messages.find((candidate) => text(candidate.path) === path);
			if (!message) return [];
			const frontmatter = record(message.frontmatter);
			return [{ projectId: text(invocation.project_id), agentSlug: text(invocation.agent_id), invocationId: text(invocation.id),
				assignmentId: text(invocation.assignment_id) || null, messageRef: path, markdown: text(message.body), status: 'responded',
				createdAt: text(frontmatter.createdAt, text(invocation.completed_at, new Date().toISOString())) }];
		});
		const statuses = invocations.map((row: Row) => text(row.status));
		const finished = statuses.filter((status: string) => ['completed', 'suspended', 'failed', 'cancelled'].includes(status)).length;
		const status = finished === invocations.length
			? responses.length === invocations.length ? 'complete' : responses.length ? 'partial' : 'failed'
			: statuses.some((value: string) => ['admitted', 'running'].includes(value)) ? 'running' : 'queued';
		const project = await contentStore.getProjectDetails(projectId);
		const targetStatus = (row: Row) => text(row.final_message_ref) || text(row.status) === 'suspended' ? 'responded'
			: text(row.status) === 'failed' ? 'failed' : text(row.status) === 'cancelled' ? 'cancelled'
				: ['admitted', 'running'].includes(text(row.status)) ? 'running' : 'queued';
		return { schemaVersion: 'treeseed.communication-send-receipt/v1', sendId: discussionId, teamId,
			channel: text(record(record(invocations[0]?.metadata_json).communication).channel, 'general'),
			topic: text(record(source?.frontmatter).topic) || null, discussionId, messageRef: text(source?.path), status,
			targets: invocations.map((row: Row) => ({ projectId: text(row.project_id), projectSlug: text(project?.project?.slug, text(row.project_id)),
				agentSlug: text(row.agent_id), definitionRevision: text(row.agent_revision), invocationId: text(row.id) || null,
				status: targetStatus(row) })),
			responses, createdAt: text(invocations[0]?.requested_at, new Date().toISOString()),
			updatedAt: text(invocations.at(-1)?.updated_at, text(invocations[0]?.requested_at, new Date().toISOString())) };
	}
	return {
		async send(principal: CapacityPrincipal, teamId: string, channel: string, body: Row, idempotencyKey?: string) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:manage:team');
			if (!discussions) throw new CapacityOperationError(503, 'discussion_service_unavailable', 'Discussion service is unavailable.');
			const projectId = text(body.projectId);
			if (!projectId) throw new CapacityOperationError(400, 'communication_project_required', 'Select a project for unambiguous agent resolution.');
			const details = await contentStore.getProjectDetails(projectId);
			if (!details?.project || text(details.project.teamId) !== teamId) throw new CapacityOperationError(404, 'communication_project_not_found', 'Project not found in the selected team.');
			const recipients = Array.isArray(body.recipients) ? body.recipients.map(String) : [];
			if (!recipients.length) throw new CapacityOperationError(400, 'communication_recipient_required', 'Select at least one project agent.');
			const projectSlug = text(details.project.slug, projectId);
			const agentSlugs = recipients.map((value) => {
				const normalized = value.trim(); const separator = normalized.indexOf('/');
				if (separator < 0) return normalized;
				const prefix = normalized.slice(0, separator); const agent = normalized.slice(separator + 1);
				if (![projectId, projectSlug].includes(prefix)) throw new CapacityOperationError(409, 'communication_target_project_mismatch', `Agent target ${normalized} does not belong to project ${projectSlug}.`);
				return agent;
			});
			const created = await discussions.create(principal, { teamId, projectId, body: body.message, topic: body.topic,
				recipients: agentSlugs, communication: { channel }, durationSeconds: Math.max(60, Number(body.waitSeconds ?? 0) || 900) }, idempotencyKey);
			for (const invocation of (Array.isArray(created.invocations) ? created.invocations : [])) {
				await store.run(`UPDATE agent_invocation_requests SET metadata_json=jsonb_set(COALESCE(metadata_json,'{}'::jsonb),'{communication}',?::jsonb,true),updated_at=? WHERE id=? AND team_id=?`,
					[JSON.stringify({ channel }), new Date().toISOString(), invocation.id, teamId]);
			}
			return sendReceipt(teamId, text(record(created.discussion).id));
		},
		async sendStatus(principal: CapacityPrincipal, teamId: string, sendId: string) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			return sendReceipt(teamId, sendId);
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
