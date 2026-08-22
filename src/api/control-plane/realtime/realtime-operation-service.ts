import { createHash, randomUUID } from 'node:crypto';
import type { OperationInvocationContext } from '../catalog/operation-registry.ts';
import type { SessionEventService } from '../../realtime/session-events.ts';
import { RealtimeOperationError } from './realtime-operation-error.ts';

type Principal = NonNullable<OperationInvocationContext['principal']>;
type Store = {
	getProject(id: string): Promise<{ id: string; teamId: string } | null | undefined>;
	resolvePrincipalTeamContext(teamId: string, principal: Principal): Promise<unknown>;
	first(query: string, parameters?: unknown[]): Promise<Record<string, any> | null | undefined>;
	all(query: string, parameters?: unknown[]): Promise<Record<string, any>[]>;
	run(query: string, parameters?: unknown[]): Promise<{ changes?: number; meta?: { changes?: number } } | unknown>;
};

const ACTION_KINDS = new Set(['navigate', 'reveal-resource', 'set-view-filter', 'populate-draft', 'present-confirmation']);
const RESULTS = new Set(['completed', 'rejected', 'failed']);
const object = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');
const affected = (value: { changes?: number; meta?: { changes?: number } }) => value.meta?.changes ?? value.changes ?? 0;

function requirePrincipal(principal: OperationInvocationContext['principal']): Principal {
	if (!principal) throw new RealtimeOperationError(401, 'authentication_required', 'An authenticated user is required.');
	return principal;
}

export function createRealtimeOperationService(store: Store, sessionEvents: SessionEventService) {
	return {
		async events(principalValue: OperationInvocationContext['principal'], query: Record<string, unknown>) {
			const principal = requirePrincipal(principalValue);
			const teamId = text(query.teamId);
			if (!teamId) throw new RealtimeOperationError(400, 'realtime_team_required', 'A team is required.');
			if (!await store.resolvePrincipalTeamContext(teamId, principal)) throw new RealtimeOperationError(403, 'team_access_denied', 'The principal cannot read this team.');
			const after = Math.max(0, Number(query.after ?? query.cursor ?? 0) || 0);
			const limit = Math.min(500, Math.max(1, Number(query.limit ?? 200) || 200));
			const items = await sessionEvents.list(teamId, after, limit);
			return { items, nextCursor: items.length === limit ? String(items.at(-1)?.sequence ?? after) : undefined };
		},

		async createSession(principalValue: OperationInvocationContext['principal'], bodyValue: Record<string, unknown>) {
			const principal = requirePrincipal(principalValue); const body = object(bodyValue);
			const projectId = text(body.projectId); const route = text(body.route);
			const capabilities = Array.isArray(body.capabilities) ? [...new Set(body.capabilities.map(String).filter((value) => ACTION_KINDS.has(value)))] : [];
			if (!projectId || !route.startsWith('/') || capabilities.length === 0) throw new RealtimeOperationError(422, 'client_session_invalid', 'Client session requires a project, application route, and supported semantic capabilities.');
			const project = await store.getProject(projectId);
			if (!project) throw new RealtimeOperationError(404, 'project_not_found', 'The project was not found.');
			if (!await store.resolvePrincipalTeamContext(project.teamId, principal)) throw new RealtimeOperationError(403, 'project_access_denied', 'The principal cannot read this project.');
			const id = text(body.sessionId) || randomUUID(); const now = new Date(); const expiresAt = new Date(now.getTime() + 45_000).toISOString();
			await store.run(`INSERT INTO agent_client_sessions (id,user_id,team_id,project_id,route,capabilities_json,status,heartbeat_at,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?, 'active',?,?,?,?) ON CONFLICT (id) DO UPDATE SET route=EXCLUDED.route,capabilities_json=EXCLUDED.capabilities_json,status='active',heartbeat_at=EXCLUDED.heartbeat_at,expires_at=EXCLUDED.expires_at,updated_at=EXCLUDED.updated_at WHERE agent_client_sessions.user_id=EXCLUDED.user_id AND agent_client_sessions.team_id=EXCLUDED.team_id AND agent_client_sessions.project_id=EXCLUDED.project_id`, [id, principal.id, project.teamId, projectId, route, JSON.stringify(capabilities), now.toISOString(), expiresAt, now.toISOString(), now.toISOString()]);
			const session = await store.first('SELECT * FROM agent_client_sessions WHERE id=? AND user_id=? AND project_id=?', [id, principal.id, projectId]);
			if (!session) throw new RealtimeOperationError(409, 'client_session_scope_conflict', 'Client session identity is bound to another scope.');
			return session;
		},

		async heartbeat(principalValue: OperationInvocationContext['principal'], sessionId: string) {
			const principal = requirePrincipal(principalValue); const now = new Date();
			const result = await store.run(`UPDATE agent_client_sessions SET heartbeat_at=?,expires_at=?,updated_at=? WHERE id=? AND user_id=? AND status='active'`, [now.toISOString(), new Date(now.getTime() + 45_000).toISOString(), now.toISOString(), sessionId, principal.id]) as { changes?: number; meta?: { changes?: number } };
			if (affected(result) !== 1) throw new RealtimeOperationError(404, 'client_session_not_found', 'Unknown active client session.');
			return await store.first('SELECT * FROM agent_client_sessions WHERE id=?', [sessionId]) ?? {};
		},

		async actions(principalValue: OperationInvocationContext['principal'], sessionId: string) {
			const principal = requirePrincipal(principalValue); const now = new Date().toISOString();
			const session = await store.first(`SELECT * FROM agent_client_sessions WHERE id=? AND user_id=? AND status='active' AND expires_at>?`, [sessionId, principal.id, now]);
			if (!session) throw new RealtimeOperationError(404, 'client_session_not_found', 'Unknown active client session.');
			await store.run(`UPDATE agent_client_actions SET status='expired',updated_at=? WHERE session_id=? AND status='pending' AND expires_at<=?`, [now, session.id, now]);
			return { items: await store.all(`SELECT * FROM agent_client_actions WHERE session_id=? AND user_id=? AND team_id=? AND project_id=? AND status='pending' AND expires_at>? ORDER BY created_at LIMIT 20`, [session.id, principal.id, session.team_id, session.project_id, now]) };
		},

		async actionResult(principalValue: OperationInvocationContext['principal'], sessionId: string, actionId: string, bodyValue: Record<string, unknown>) {
			const principal = requirePrincipal(principalValue); const body = object(bodyValue); const status = text(body.status);
			if (!RESULTS.has(status)) throw new RealtimeOperationError(422, 'client_action_result_invalid', 'Client action result must be completed, rejected, or failed.');
			const now = new Date().toISOString();
			const result = await store.run(`UPDATE agent_client_actions SET status=?,result_json=?,completed_at=?,updated_at=? WHERE id=? AND session_id=? AND user_id=? AND status='pending'`, [status, JSON.stringify({ detail: object(body.detail), digest: digest(body.detail) }), now, now, actionId, sessionId, principal.id]) as { changes?: number; meta?: { changes?: number } };
			if (affected(result) !== 1) {
				const replay = await store.first('SELECT * FROM agent_client_actions WHERE id=? AND session_id=? AND user_id=?', [actionId, sessionId, principal.id]);
				if (replay?.status === status) return { ...replay, replayed: true };
				throw new RealtimeOperationError(409, 'client_action_state_conflict', 'Client action is missing, terminal, expired, or outside this user session.');
			}
			return await store.first('SELECT * FROM agent_client_actions WHERE id=?', [actionId]) ?? {};
		},
	};
}
