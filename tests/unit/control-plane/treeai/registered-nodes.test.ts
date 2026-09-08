import { expect, it, vi } from 'vitest';
import { TREEAI_UPSTREAM_OPERATIONS } from '@treeseed/sdk/treeai';
import { createRegisteredAiNodes, localAiRuntime } from '../../../../src/api/control-plane/treeai/registered-nodes.ts';

const teamId = '10000000-0000-4000-8000-000000000001', nodeId = '10000000-0000-4000-8000-000000000002', projectId = '10000000-0000-4000-8000-000000000003';
const runtime = { teamId, nodeId, projectId, endpoints: { inference: 'http://inference-api:4770', training: 'http://training-api:4780' } };
const input = { name: 'Managed AI', projectId, purpose: 'both', model: 'local-model' };
const principal = { id: 'user' }, context = { principal, interface: 'rest' as const, requestId: 'request' };
function fixture() {
	let row: any = null;
	const store = {
		ensureInitialized: vi.fn(), principalCanAccessTeam: vi.fn(async () => true), principalCanManageServices: vi.fn(async () => true),
		first: vi.fn(async (sql: string, args: any[]) => {
			if (sql.startsWith('SELECT id FROM projects')) return { id: projectId };
			if (sql.startsWith('INSERT')) row = { id: args[0], team_id: args[1], configuration_json: args[2], version: 1 };
			return row;
		}),
	};
	const authority = { mintAi: vi.fn(() => 'short-lived-operation-token') };
	const fetcher = vi.fn(async (_url: URL | RequestInfo, options?: RequestInit) => { expect(options?.redirect).toBe('error'); return new Response('{}'); });
	const service = createRegisteredAiNodes(store, authority as any, { TREESEED_AI_RUNTIME: JSON.stringify(runtime) }, fetcher);
	return { service, store, authority, fetcher, revoke: () => { row = null; } };
}

it('registers only a ready manager-bound runtime and repeats as noop without returning credentials', async () => {
	const { service, fetcher } = fixture();
	const result = await service.register(principal, teamId, nodeId, input, 'new');
	expect(result).toMatchObject({ status: 'registered', healthy: true, version: 1, noop: false });
	expect(JSON.stringify(result)).not.toMatch(/token|credential|endpoints/i);
	expect(fetcher).toHaveBeenCalledTimes(2);
	expect(await service.register(principal, teamId, nodeId, input, '1')).toMatchObject({ noop: true, version: 1 });
	await expect(service.register(principal, teamId, nodeId, input, 'new')).rejects.toMatchObject({ status: 412 });
});

it('rejects cross-team/node/project assignment, unauthorized writes, and failed readiness before saving', async () => {
	const { service, store, fetcher } = fixture();
	for (const [team, node, project] of [['other', nodeId, projectId], [teamId, 'other', projectId], [teamId, nodeId, 'other']])
		await expect(service.register(principal, team!, node!, { ...input, projectId: project! }, 'new')).rejects.toMatchObject({ status: 409 });
	store.principalCanManageServices.mockResolvedValue(false);
	await expect(service.register(principal, teamId, nodeId, input, 'new')).rejects.toMatchObject({ status: 403 });
	store.principalCanManageServices.mockResolvedValue(true); fetcher.mockResolvedValue(new Response('{}', { status: 503 }));
	await expect(service.register(principal, teamId, nodeId, input, 'new')).rejects.toMatchObject({ status: 503 });
	expect(store.first.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
});

it('mints only the requested adopted scopes and denies new calls after revocation or team access loss', async () => {
	const { service, store, authority, revoke } = fixture();
	const operation = TREEAI_UPSTREAM_OPERATIONS.find(item => item.service === 'inference' && item.kind === 'read')!;
	expect(await service.resolve(nodeId, operation.operationId, context as any)).toBeNull();
	await service.register(principal, teamId, nodeId, input, 'new');
	expect(await service.resolve(nodeId, operation.operationId, context as any)).toMatchObject({ token: 'short-lived-operation-token' });
	expect(authority.mintAi).toHaveBeenCalledWith({ actorId: 'user', teamId, nodeId, service: 'inference', scopes: operation.scopes });
	store.principalCanAccessTeam.mockResolvedValue(false);
	await expect(service.resolve(nodeId, operation.operationId, context as any)).rejects.toMatchObject({ status: 403 });
	store.principalCanAccessTeam.mockResolvedValue(true); revoke();
	expect(await service.resolve(nodeId, operation.operationId, context as any)).toBeNull();
	expect(authority.mintAi).toHaveBeenCalledTimes(1);
});

it('rejects malformed runtime configuration and unapproved plaintext routes', () => {
	expect(localAiRuntime({})).toBeNull();
	for (const value of [null, {}, { ...runtime, nodeId: '-'.repeat(36) }, { ...runtime, endpoints: {} },
		...['http://169.254.169.254', 'http://localhost', 'https://user:password@vault.test', 'not-url'].map(endpoint => ({ ...runtime, endpoints: { inference: endpoint } }))])
		expect(() => localAiRuntime({ TREESEED_AI_RUNTIME: JSON.stringify(value) })).toThrow(/Managed AI/);
});
