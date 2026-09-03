import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { planHostedTopology } from '@treeseed/sdk/deployment';
import type { BoundOperation } from '../../../../src/api/control-plane/catalog/operation-registry.ts';
import { createOperationHttpHandler } from '../../../../src/api/control-plane/http/operation-http-handler.ts';

describe('catalogued POST read request bodies', () => {
	it('parses the body according to the REST method rather than mutation classification', async () => {
		const operation: BoundOperation<typeof CONTROL_PLANE_OPERATIONS.seeds.validate> = {
			binding: CONTROL_PLANE_OPERATIONS.seeds.validate,
			async handler(value) { return { received: value.body }; },
		};
		const authenticate = async () => ({ token: 'test-token', clientId: 'client-1', scopes: ['treeseed:admin'],
			extra: { principal: { id: 'user-1', roles: ['platform_admin'], permissions: ['*:*:*'] } } });
		const app = new Hono();
		app.post('/v1/seeds/validate', createOperationHttpHandler(operation, authenticate, 'sha256:test'));
		const response = await app.request('/v1/seeds/validate', { method: 'POST', headers: {
			'content-type': 'application/json', authorization: 'Bearer test-token',
		}, body: JSON.stringify({ bundle: { schemaVersion: 'treeseed.seed-bundle/v2', name: 'treeseed' } }) });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ data: { received: { bundle: { schemaVersion: 'treeseed.seed-bundle/v2', name: 'treeseed' } } } });
	});

	it('accepts the current typed hosted-topology declaration at the REST boundary', async () => {
		const declaration = {
			schemaVersion: 'treeseed.hosted-topology/v1' as const, id: 'staging', teamId: 'team-1', deploymentId: 'treeseed-cloud', stackId: 'control-plane', environment: 'staging' as const,
			mutation: 'agent-authorized' as const, platform: { repository: 'treeseed-ai/platform' as const, commit: 'a'.repeat(40) }, stateBackend: { connectionRef: 'cloudflare-state' }, providerConnections: { cloudflare: { connectionRef: 'cloudflare-hosting' } },
			artifacts: { admin: { kind: 'archive' as const, format: 'tar+gzip' as const, digest: `sha256:${'b'.repeat(64)}`, source: 'https://example.test/admin.tgz' } },
			resources: [{ id: 'admin', provider: 'cloudflare' as const, kind: 'pages-application' as const, dependsOn: [], parameters: { name: { input: 'admin-name' }, artifact: { artifact: 'admin' }, 'artifact-format': { literal: 'tar+gzip' }, 'production-branch': { literal: 'staging' }, 'destination-dir': { literal: '.' } }, adoption: { mode: 'adopt-or-create' as const, replacement: 'forbidden' as const } }],
		};
		const operation: BoundOperation<typeof CONTROL_PLANE_OPERATIONS.infrastructure.topology.plan> = { binding: CONTROL_PLANE_OPERATIONS.infrastructure.topology.plan,
			async handler(value) { return planHostedTopology({ declaration: value.body.declaration, observations: [], connections: {}, stateBackend: null }); } };
		const authenticate = async () => ({ token: 'test-token', clientId: 'client-1', scopes: ['treeseed:read'], extra: { principal: { id: 'user-1', roles: ['platform_admin'], permissions: ['*:*:*'] } } });
		const app = new Hono(); app.post('/v1/teams/:teamId/infrastructure/topology/plan', createOperationHttpHandler(operation, authenticate, 'sha256:test'));
		const response = await app.request('/v1/teams/team-1/infrastructure/topology/plan', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' }, body: JSON.stringify({ declaration }) });
		expect(response.status).toBe(200);
		expect((await response.json() as any).data.artifacts.admin.kind).toBe('archive');
	});
});
