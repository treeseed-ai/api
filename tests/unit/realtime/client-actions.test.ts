import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { installClientActionRoutes } from '../../../src/api/routes/realtime/client-actions.ts';

type Row = Record<string, unknown>;

function harness() {
	const sessions = new Map<string, Row>();
	const actions = new Map<string, Row>();
	const app = new Hono();
	app.use('*', async (context, next) => {
		context.set('principal', { id: context.req.header('x-user') ?? 'user-a' });
		context.set('actorType', 'user');
		await next();
	});
	const store = {
		async run(query: string, params: unknown[] = []) {
			if (query.includes('INSERT INTO agent_client_sessions')) {
				const [id, userId, teamId, projectId, route, capabilities, heartbeatAt, expiresAt, createdAt, updatedAt] = params;
				const existing = sessions.get(String(id));
				if (existing && (existing.user_id !== userId || existing.team_id !== teamId || existing.project_id !== projectId)) return { changes: 0 };
				sessions.set(String(id), { id, user_id: userId, team_id: teamId, project_id: projectId, route, capabilities_json: capabilities, status: 'active', heartbeat_at: heartbeatAt, expires_at: expiresAt, created_at: createdAt, updated_at: updatedAt });
				return { changes: 1 };
			}
			if (query.includes('UPDATE agent_client_sessions SET heartbeat_at')) {
				const [heartbeatAt, expiresAt, updatedAt, id, userId] = params;
				const session = sessions.get(String(id));
				if (!session || session.user_id !== userId || session.status !== 'active') return { changes: 0 };
				Object.assign(session, { heartbeat_at: heartbeatAt, expires_at: expiresAt, updated_at: updatedAt });
				return { changes: 1 };
			}
			if (query.includes("UPDATE agent_client_actions SET status='expired'")) return { changes: 0 };
			if (query.includes('UPDATE agent_client_actions SET status=?')) {
				const [status, resultJson, completedAt, updatedAt, id, sessionId, userId] = params;
				const action = actions.get(String(id));
				if (!action || action.session_id !== sessionId || action.user_id !== userId || action.status !== 'pending') return { changes: 0 };
				Object.assign(action, { status, result_json: resultJson, completed_at: completedAt, updated_at: updatedAt });
				return { changes: 1 };
			}
			throw new Error(`Unexpected query: ${query}`);
		},
		async first(query: string, params: unknown[] = []) {
			if (!query.includes('agent_client_sessions') && !query.includes('agent_client_actions')) return null;
			const source = query.includes('agent_client_sessions') ? sessions : actions;
			const row = source.get(String(params[0]));
			if (!row) return null;
			if (query.includes('user_id=?') && row.user_id !== params.at(-1) && row.user_id !== params[1]) return null;
			if (query.includes('project_id=?') && row.project_id !== params.at(-1)) return null;
			return row;
		},
		async all(query: string, params: unknown[] = []) {
			if (!query.includes('agent_client_actions')) return [];
			return [...actions.values()].filter((action) => action.session_id === params[0] && action.user_id === params[1] && action.status === 'pending');
		},
	};
	installClientActionRoutes({
		app, store,
		jsonError: (context: any, status: number, message: string, details: Row = {}) => context.json({ ok: false, message, ...details }, status),
		requireProjectAccess: async (_context: unknown, _store: unknown, projectId: string) => ({ details: { project: { id: projectId, teamId: 'team-a' } } }),
	});
	return { app, sessions, actions };
}

describe('semantic client actions', () => {
	it('binds a session to one user and project and rejects cross-user heartbeats', async () => {
		const { app } = harness();
		const created = await app.request('/v1/client-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-a', projectId: 'project-a', route: '/app/projects/project-a', capabilities: ['navigate', 'javascript'] }) });
		expect(created.status).toBe(201);
		expect((await created.json() as any).payload.capabilities_json).toBe('["navigate"]');
		const denied = await app.request('/v1/client-sessions/session-a/heartbeat', { method: 'POST', headers: { 'x-user': 'user-b' } });
		expect(denied.status).toBe(404);
	});

	it('returns only pending actions in the exact user session and records an idempotent result', async () => {
		const { app, sessions, actions } = harness();
		const future = new Date(Date.now() + 30_000).toISOString();
		sessions.set('session-a', { id: 'session-a', user_id: 'user-a', team_id: 'team-a', project_id: 'project-a', status: 'active', expires_at: future });
		actions.set('action-a', { id: 'action-a', session_id: 'session-a', user_id: 'user-a', team_id: 'team-a', project_id: 'project-a', status: 'pending', expires_at: future });
		actions.set('action-b', { id: 'action-b', session_id: 'session-a', user_id: 'user-b', team_id: 'team-a', project_id: 'project-a', status: 'pending', expires_at: future });
		const listed = await app.request('/v1/client-sessions/session-a/actions');
		expect((await listed.json() as any).payload.map((entry: Row) => entry.id)).toEqual(['action-a']);
		const input = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'completed', detail: { route: '/app/projects/project-a' } }) };
		expect((await app.request('/v1/client-sessions/session-a/actions/action-a/result', input)).status).toBe(200);
		const replay = await app.request('/v1/client-sessions/session-a/actions/action-a/result', input);
		expect((await replay.json() as any).replayed).toBe(true);
	});
});
