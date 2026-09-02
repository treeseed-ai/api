import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { planHostedTopology, type HostedTopologyDeclaration } from '@treeseed/sdk/deployment';
import { CloudflareHostedAdapter } from '../../../../src/operations-runner/infrastructure/cloudflare-hosted-adapter.ts';
import { resolveHostedProviderAuthority } from '../../../../src/operations-runner/infrastructure/hosted-provider-authority.ts';
import { RailwayHostedAdapter } from '../../../../src/operations-runner/infrastructure/railway-hosted-adapter.ts';

const sha = (body: string) => `sha256:${createHash('sha256').update(body).digest('hex')}`;
const missing = (resource: HostedTopologyDeclaration['resources'][number]) => ({ resourceId: resource.id, provider: resource.provider,
	kind: resource.kind, providerResourceId: null, state: 'missing' as const, managedBy: null, observedDigest: null, observedAt: '2026-09-02T12:00:00.000Z' });

describe('hosted production provider adapters', () => {
	it('verifies and deploys an exact Cloudflare Worker artifact before authoritative read-back', async () => {
		const body = 'export default { fetch() { return new Response("ok") } }'; let deployed: ArrayBuffer | null = null;
		const resource = { id: 'admin', provider: 'cloudflare' as const, kind: 'admin-application' as const, dependsOn: [],
			parameters: { name: { literal: 'treeseed-admin' as const }, artifact: { artifact: 'admin' }, 'public-url': { literal: 'https://admin.example.test' } },
			adoption: { mode: 'adopt-or-create' as const, replacement: 'forbidden' as const } };
		const declaration: HostedTopologyDeclaration = { schemaVersion: 'treeseed.hosted-topology/v1', id: 'production', environment: 'production', mutation: 'approval-required',
			platform: { repository: 'treeseed-ai/platform', commit: 'a'.repeat(40) }, providerConnections: { cloudflare: { connectionRef: 'cloudflare-production' } },
			artifacts: { admin: { digest: sha(body), source: 'https://artifacts.example.test/admin.js' } }, resources: [resource] };
		const plan = planHostedTopology({ declaration, observations: [missing(resource)], connections: { cloudflare: { connectionRef: 'cloudflare-production', nonSecretConfig: { accountId: 'account' } } } });
		const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const target = String(url); if (target.includes('artifacts.example.test')) return new Response(body, { status: 200, headers: { 'content-type': 'application/javascript' } });
			if (init?.method === 'PUT') { deployed = init.body as ArrayBuffer; return new Response('{}', { status: 200 }); }
			return deployed ? new Response(deployed, { status: 200 }) : new Response('', { status: 404 });
		}) as unknown as typeof fetch;
		const adapter = new CloudflareHostedAdapter(fetchImpl); await adapter.applyAction({ action: plan.actions[0]!, plan, token: 'scoped', outputs: {} });
		const observed = await adapter.observeResource({ resource, config: { accountId: 'account' }, artifacts: declaration.artifacts, token: 'scoped', managed: true });
		expect(observed).toMatchObject({ state: 'healthy', managedBy: 'treeseed', observedDigest: plan.actions[0]!.desiredDigest });
		expect(deployed).not.toBeNull();
	});

	it('creates a Railway service, records its desired digest, deploys, and reads it back', async () => {
		const resource = { id: 'api', provider: 'railway' as const, kind: 'control-plane-api' as const, dependsOn: [],
			parameters: { name: { literal: 'treeseed-api' as const }, artifact: { artifact: 'api' } }, adoption: { mode: 'adopt-or-create' as const, replacement: 'forbidden' as const } };
		const declaration: HostedTopologyDeclaration = { schemaVersion: 'treeseed.hosted-topology/v1', id: 'production', environment: 'production', mutation: 'approval-required',
			platform: { repository: 'treeseed-ai/platform', commit: 'a'.repeat(40) }, providerConnections: { railway: { connectionRef: 'railway-production' } },
			artifacts: { api: { digest: `sha256:${'a'.repeat(64)}`, source: 'https://ghcr.io/treeseed/api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }, resources: [resource] };
		const connections = { railway: { connectionRef: 'railway-production', nonSecretConfig: { workspaceId: 'workspace', projectId: 'project', environmentId: 'environment' } } };
		const plan = planHostedTopology({ declaration, observations: [missing(resource)], connections }); let marker: string | undefined, created = false;
		const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => { const request = JSON.parse(String(init?.body)), query = String(request.query);
			if (query.includes('TreeSeedServiceCreate')) { created = true; return Response.json({ data: { serviceCreate: { id: 'service-api' } } }); }
			if (query.includes('TreeSeedVariables')) { marker = request.variables.input.variables.TREESEED_RESOURCE_DIGEST; return Response.json({ data: { variableCollectionUpsert: true } }); }
			if (query.includes('TreeSeedDeploy')) return Response.json({ data: { serviceInstanceDeploy: true } });
			return Response.json({ data: { project: { services: { edges: created ? [{ node: { id: 'service-api', name: 'treeseed-api' } }] : [] } }, variables: marker ? { 'service-api': { TREESEED_RESOURCE_DIGEST: marker } } : {} } });
		}) as unknown as typeof fetch;
		const adapter = new RailwayHostedAdapter(fetchImpl); await adapter.applyAction({ action: plan.actions[0]!, plan, token: 'scoped', outputs: {} });
		const observed = await adapter.observeResource({ resource, config: connections.railway.nonSecretConfig, artifacts: declaration.artifacts, token: 'scoped', managed: true });
		expect(observed).toMatchObject({ providerResourceId: 'service-api', state: 'healthy', observedDigest: plan.actions[0]!.desiredDigest });
	});

	it('resolves only ready capability-scoped unattended authority', async () => {
		const store = { first: vi.fn(async () => ({ scheme: 'environment-reference', reference: 'TREESEED_CLOUDFLARE_RUNTIME_TOKEN', capabilities_json: '["frontend-hosting"]' })) };
		const authority = await resolveHostedProviderAuthority({ store, teamId: 'team', connectionRef: 'cloudflare-production', provider: 'cloudflare', kind: 'admin-application', env: { TREESEED_CLOUDFLARE_RUNTIME_TOKEN: 'value' } });
		expect(authority).toMatchObject({ profile: 'cloudflare-runtime', capability: 'frontend-hosting' });
		expect(JSON.stringify(authority)).toContain('value');
		await expect(resolveHostedProviderAuthority({ store, teamId: 'team', connectionRef: 'cloudflare-production', provider: 'cloudflare', kind: 'admin-application', env: {} })).rejects.toThrow(/unavailable/u);
	});
});
