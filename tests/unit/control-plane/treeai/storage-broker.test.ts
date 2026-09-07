import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { aiStorageProofMessage } from '@treeseed/sdk/deployment';
import { createAiStorageBroker, installAiStorageBrokerRoute } from '../../../../src/api/control-plane/treeai/storage-broker.ts';
import { createAiStorageBindings } from '../../../../src/api/control-plane/treeai/storage-binding.ts';

const teamId = '11111111-1111-4111-8111-111111111111', projectId = '22222222-2222-4222-8222-222222222222';
const nodeId = '33333333-3333-4333-8333-333333333333', connectionId = '44444444-4444-4444-8444-444444444444';
const keys = generateKeyPairSync('ed25519');
function fixture() {
	const node = { configuration_json: JSON.stringify({ origin: 'managed-local', projectId, purpose: 'both' }) };
	const binding = { team_id: teamId, node_id: nodeId, connection_id: connectionId, bucket: 'test-artifacts', version: 1, status: 'active' };
	const connection = { id: connectionId, teamId, providerId: 'cloudflare', status: 'active', version: 1, nonSecretConfig: { accountId: 'a'.repeat(32) },
		capabilities: [{ capabilityType: 'object-storage', credentialProfileId: 'cloudflare-storage', status: 'configured' }] };
	const seen = new Set<string>();
	const store = { ensureInitialized: vi.fn(), principalCanAccessTeam: vi.fn(async () => true), principalCanManageServices: vi.fn(async () => true),
		getTeamServiceConnection: vi.fn(async () => connection), run: vi.fn(), recordAuditEvent: vi.fn(),
		first: vi.fn(async (query: string, params: any[] = []): Promise<any> => {
			if (query.startsWith('WITH allowance')) { const nonce = params[6]; if (seen.has(nonce)) return null; seen.add(nonce); return { nonce }; }
			if (query.includes('FROM team_ai_instances')) return node;
			if (query.includes('FROM team_ai_storage_bindings')) return binding.status === 'active' || !query.includes("status='active'") ? binding : null;
			if (query.includes('FROM projects')) return { id: projectId };
			if (query.includes('SELECT reference')) return null;
			if (query.includes('provider_credential_authorities')) return { version: 1, capabilities_json: '["object-storage"]' };
			throw new Error(`Unexpected test query ${query}`);
		}) };
	const custody = { read: vi.fn(async () => ({ version: 1, values: { apiToken: 'synthetic-parent-secret' } })) };
	const session = vi.fn(async (_scope: any, run: any) => run(custody));
	const mint = vi.fn(async (..._args: any[]) => ({ endpoint: 'https://storage.example', bucket: binding.bucket, prefix: 'bounded/', objectKey: 'bounded/model.bin',
		expiresAt: new Date(160_000).toISOString(), credentials: { accessKeyId: 'temporary-id', secretAccessKey: 'temporary-secret', sessionToken: 'temporary-session' } }));
	const env = { TREESEED_AI_RUNTIME: JSON.stringify({ nodeId, teamId, projectId, endpoints: { inference: 'http://inference-api:4770', training: 'http://training-api:4780' } }),
		TREESEED_AI_STORAGE_PUBLIC_KEYS: JSON.stringify({ training: keys.publicKey.export({ type: 'spki', format: 'pem' }), inference: keys.publicKey.export({ type: 'spki', format: 'pem' }) }) };
	const proof = { schemaVersion: 'treeseed.ai-storage-proof/v1' as const, teamId, projectId, nodeId, service: 'training' as const,
		storeId: 'managed-training' as const, action: 'read' as const, key: 'model.bin', issuedAt: 100, nonce: randomUUID() };
	const request = (changes: Record<string, unknown> = {}) => { const value = { ...proof, ...changes }; return { proof: value,
		signature: sign(null, Buffer.from(aiStorageProofMessage(value as typeof proof)), keys.privateKey).toString('base64url') }; };
	return { node, binding, connection, store, custody, session, mint, request, issue: createAiStorageBroker(store, { env, session, mint, now: () => 100 }) };
}

describe('registered AI storage custody', () => {
	it('resolves current service custody after workload proof and records no secret material', async () => {
		const f = fixture(); const result = await f.issue(f.request());
		expect(result.credentials.sessionToken).toBe('temporary-session'); expect(f.session).toHaveBeenCalledOnce();
		expect(f.mint.mock.calls[0]?.[0]).toMatchObject({ apiToken: 'synthetic-parent-secret', operation: { teamId, projectId, nodeId, action: 'read' } });
		expect(JSON.stringify(f.store.recordAuditEvent.mock.calls)).not.toMatch(/synthetic-parent-secret|temporary-secret|temporary-session/);
	});
	it.each([{ teamId: connectionId }, { projectId: connectionId }, { nodeId: connectionId }, { issuedAt: 69 }, { issuedAt: 106 },
		{ service: 'inference', storeId: 'managed-training', action: 'write' }])('rejects wrong authority or stale proof %j before storage access', async change => {
		const f = fixture(); await expect(f.issue(f.request(change))).rejects.toMatchObject({ status: 401 });
		expect(f.session).not.toHaveBeenCalled(); expect(f.store.first).not.toHaveBeenCalled();
	});
	it('rejects a forged signature and replays before minting a second credential', async () => {
		const f = fixture(), request = f.request();
		await expect(f.issue({ ...request, signature: 'A'.repeat(86) })).rejects.toMatchObject({ status: 401 });
		await f.issue(request); await expect(f.issue(request)).rejects.toMatchObject({ status: 409 }); expect(f.mint).toHaveBeenCalledOnce();
	});
	it.each(['revoked', 'connection', 'capability', 'team', 'node', 'version'])('fails closed for %s authority', async kind => {
		const f = fixture();
		if (kind === 'revoked') f.binding.status = 'revoked';
		if (kind === 'connection') f.connection.status = 'disconnected';
		if (kind === 'capability') f.connection.capabilities = [];
		if (kind === 'team') f.connection.teamId = connectionId;
		if (kind === 'node') f.node.configuration_json = JSON.stringify({ origin: 'managed-local', projectId: connectionId, purpose: 'both' });
		if (kind === 'version') f.custody.read.mockResolvedValue({ version: 2, values: { apiToken: 'synthetic-parent-secret' } });
		await expect(f.issue(f.request())).rejects.toBeInstanceOf(Error); expect(f.mint).not.toHaveBeenCalled();
	});
	it('discards an issued credential when access changes before delivery', async () => {
		const f = fixture(); f.mint.mockImplementationOnce(async () => { f.binding.status = 'revoked'; return { ...await fixture().mint() }; });
		await expect(f.issue(f.request())).rejects.toMatchObject({ status: 403 });
	});
	it('keeps binding management concurrency and relocation fail-closed', async () => {
		const f = fixture(), ensureBucket = vi.fn(), service = createAiStorageBindings(f.store, { session: f.session, ensureBucket });
		await expect(service.put({ id: 'user' }, teamId, nodeId, { connectionId, bucket: 'test-artifacts' }, '0')).rejects.toMatchObject({ status: 412 });
		await expect(service.put({ id: 'user' }, teamId, nodeId, { connectionId, bucket: 'different-bucket' }, '1')).rejects.toMatchObject({ status: 409 });
		expect(ensureBucket).not.toHaveBeenCalled(); expect(f.session).not.toHaveBeenCalled();
	});
	it('requires credential capability authority independently of connection configuration', async () => {
		const f = fixture(), first = f.store.first.getMockImplementation()!;
		f.store.first.mockImplementation((query, params) => query.includes('provider_credential_authorities')
			? Promise.resolve({ version: 1, capabilities_json: '[]' }) : first(query, params));
		await expect(f.issue(f.request())).rejects.toMatchObject({ status: 403 });
		expect(f.session).not.toHaveBeenCalled();
	});
	it('rejects oversized HTTP requests and does not cache or expose backend failures', async () => {
		const app = new Hono(), issue = vi.fn(async () => { throw new Error('synthetic-sensitive-backend-value'); });
		installAiStorageBrokerRoute(app, issue);
		const large = await app.request('/v1/internal/ai/storage/credentials', { method: 'POST', body: 'x'.repeat(4097) });
		expect(large.status).toBe(413); expect(issue).not.toHaveBeenCalled();
		const failed = await app.request('/v1/internal/ai/storage/credentials', { method: 'POST', body: '{}' });
		expect(failed.status).toBe(503); expect(failed.headers.get('cache-control')).toBe('no-store');
		expect(await failed.text()).not.toContain('synthetic-sensitive-backend-value');
	});
	it('rejects a connection edited while verifying bucket access', async () => {
		const f = fixture();
		const ensureBucket = vi.fn(async () => { f.store.getTeamServiceConnection.mockResolvedValue({ ...f.connection, version: 2 }); });
		const service = createAiStorageBindings(f.store, { session: f.session, ensureBucket: ensureBucket as any });
		await expect(service.put({ id: 'user' }, teamId, nodeId, { connectionId, bucket: 'test-artifacts' }, '1')).rejects.toMatchObject({ status: 412 });
		expect(f.store.recordAuditEvent).not.toHaveBeenCalled();
	});
});
