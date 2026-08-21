import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { TREESEED_COMMAND_TREE_V1, type CommandNodeDescriptor } from '@treeseed/sdk/operator-contracts';
import { API_COMMAND_AUTHORITY } from '../../../src/api/capacity/operator-command-authority.ts';
import { installOperatorCommandRoute } from '../../../src/api/capacity/routes/support/operator-command.ts';

function appWithAccess(response?: Response) {
	const app = new Hono();
	const store = {
		getTeam: vi.fn(async (id: string) => id === 'team-a' ? { id } : null),
		getTeamBySlug: vi.fn(async () => null),
		getProjectDetails: vi.fn(async (id: string) => id === 'project-a' ? { project: { id, teamId: 'team-a' } } : null),
		getProjectByTeamAndSlug: vi.fn(async () => null),
		updateCapacityWorkdayRun: vi.fn(async () => null),
	};
	const requireTeamAccess = vi.fn(async () => ({ response: response ?? null }));
	installOperatorCommandRoute(app, { store: store as never, requireTeamAccess });
	return { app, store, requireTeamAccess };
}

const body = (commandPath: string[], mode: 'execute' | 'plan' = 'execute') => ({
	schemaVersion: 'treeseed.operator-command-request/v1', commandPath, arguments: ['workday-a'], options: {}, mode, context: { team: 'team-a' },
});

function leaves(nodes: CommandNodeDescriptor[], parent: string[] = []): Array<{ path: string[]; args: string[] }> {
	return nodes.flatMap((node) => {
		const path = [...parent, node.segment];
		return node.nodeType === 'branch' ? leaves(node.children, path) : [{ path, args: (node.arguments ?? []).filter((argument) => argument.required).map((argument) => `${argument.name}-a`) }];
	});
}

it('binds every nonlocal SDK command to API authority without a missing-route fallback', async () => {
	const { app, requireTeamAccess } = appWithAccess();
	app.all('/v1/*', (c) => c.json({ ok: true, payload: { downstream: c.req.path } }));
	const authority = new Map(API_COMMAND_AUTHORITY.map((binding) => [binding.commandPath, binding.access]));
	const commands = leaves(TREESEED_COMMAND_TREE_V1.commands).filter(({ path }) => !['auth', 'secrets'].includes(path[0]!));
	for (const command of commands) {
		const name = command.path.join(' ');
		const access = authority.get(name);
		expect(access, name).toBeDefined();
		const authorizationCalls = requireTeamAccess.mock.calls.length;
		const response = await app.request(`/v1/operator/commands/${access === 'team-manage' ? 'mutations' : 'read'}`, {
			method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
				schemaVersion: 'treeseed.operator-command-request/v1', commandPath: command.path, arguments: command.args,
				options: { decision: 'decision-a', credential: 'credential-a', preflight: 'preflight-a', digest: 'sha256:a', document: {} },
				mode: access === 'team-manage' ? 'plan' : 'execute', context: { team: 'team-a', project: 'project-a' },
			}),
		});
		const payload = await response.json() as { code?: string };
		expect(payload.code, name).not.toBe('operator_route_missing');
		expect(response.status, name).not.toBe(501);
		expect(requireTeamAccess.mock.calls.length, name).toBe(authorizationCalls + 1);
	}
});

describe('API-owned operator command boundary', () => {
	it('returns an exact no-mutation proposal without calling a workday implementation', async () => {
		const { app, store, requireTeamAccess } = appWithAccess();
		const response = await app.request('/v1/operator/commands/mutations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body(['workdays', 'cancel'], 'plan')) });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, payload: { mutation: false, resource: { type: 'workday', id: 'workday-a' }, change: { status: 'cancelled' } } });
		expect(store.updateCapacityWorkdayRun).not.toHaveBeenCalled();
		expect(requireTeamAccess).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'team-a', 'teams:manage:team');
	});

	it('rejects attempts to send a mutation through the read boundary', async () => {
		const { app } = appWithAccess();
		const response = await app.request('/v1/operator/commands/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body(['workdays', 'cancel'], 'plan')) });
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ ok: false, code: 'operator_access_route_mismatch' });
	});

	it('enforces API team authority before returning a plan', async () => {
		const { app } = appWithAccess(new Response(JSON.stringify({ ok: false, code: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } }));
		const response = await app.request('/v1/operator/commands/mutations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body(['workdays', 'cancel'], 'plan')) });
		expect(response.status).toBe(403);
	});

	it('derives idempotency from high-level intent rather than a command-wide constant', async () => {
		const { app } = appWithAccess();
		const request = async (digest: string) => {
			const response = await app.request('/v1/operator/commands/mutations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body(['workdays', 'start'], 'plan'), arguments: [], options: { preflight: 'preflight-a', digest } }) });
			return response.json() as Promise<{ payload: { body: { idempotencyKey: string } } }>;
		};
		const left = await request('sha256:left');
		const right = await request('sha256:right');
		expect(left.payload.body.idempotencyKey).not.toBe(right.payload.body.idempotencyKey);
	});
});
