import { normalizeCapacityPageLimit } from '@treeseed/sdk/capacity-pagination';
import { authorizeCapacityTeam, type CapacityPrincipal } from './capacity-authorization.ts';
import { CapacityOperationError } from './capacity-operation-error.ts';

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

function requestedLimit(query: Row) {
	try { return normalizeCapacityPageLimit(query.limit); }
	catch (error) { throw new CapacityOperationError(400, 'capacity_page_invalid', error instanceof Error ? error.message : String(error)); }
}

async function invocation(store: any, teamId: string, invocationId: string) {
	const row = await store.first('SELECT * FROM agent_invocation_requests WHERE id=? AND team_id=?', [invocationId, teamId]);
	if (!row) throw new CapacityOperationError(404, 'agent_invocation_not_found', 'Agent invocation not found.');
	return row as Row;
}

export function createCommunicationService(store: any) {
	return {
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
