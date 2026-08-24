import { createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { installRemoteCredentialBrokerRoute } from '../../../../src/api/control-plane/treedx/remote-credential-broker.ts';

const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const digest = 'a'.repeat(64);

function delivery(overrides: Record<string, unknown> = {}) {
	return { id: 'delivery-1', grant_id: 'grant-1', node_id: 'node_local', treedx_node_id: 'node_local', status: 'ready',
		grant_status: 'delivered', operation_kind: 'push', allowed_host: 'github.com', refspec_digest: digest,
		expires_at: new Date(Date.now() + 60_000).toISOString(), credential_authority_id: 'authority-1',
		repository_binding_id: 'repository-1', ...overrides };
}

function fixture(overrides: { row?: Record<string, unknown> | null; consumed?: boolean } = {}) {
	const row = overrides.row === null ? null : delivery(overrides.row);
	const store = {
		first: vi.fn(async (query: string) => query.startsWith('SELECT') ? row : (overrides.consumed === false ? null : { id: 'delivery-1' })),
		run: vi.fn(async () => ({ changes: 1 })),
	};
	const resolveCredential = vi.fn(async () => ({ token: 'github-token', username: 'x-access-token', expiresAt: null, authorityScheme: 'environment-reference' }));
	const app = new Hono();
	installRemoteCredentialBrokerRoute(app, { store, assertion: 'shared-broker-assertion', resolveCredential });
	return { app, store, resolveCredential };
}

function request(app: Hono, input: { nodeId?: string; assertion?: string; operation?: string; allowedHost?: string; publicKey?: string } = {}) {
	const pair = generateKeyPairSync('x25519');
	const publicKey = input.publicKey ?? pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
	return { pair, response: app.request('/v1/internal/credential-deliveries/consume', {
		method: 'POST', headers: { 'content-type': 'application/json', 'x-treedx-node-id': input.nodeId ?? 'node_local',
			authorization: `Bearer ${input.assertion ?? 'shared-broker-assertion'}` },
		body: JSON.stringify({ deliveryId: 'delivery-1', nodePublicKey: publicKey, operation: input.operation ?? 'push',
			allowedHost: input.allowedHost ?? 'github.com', refspecDigest: digest }),
	}) };
}

describe('TreeDX remote credential broker', () => {
	it('seals the selected one-time credential to the requesting node key', async () => {
		const { app, store, resolveCredential } = fixture();
		const { pair, response } = request(app); const result = await response;
		expect(result.status).toBe(200);
		const envelope = (await result.json() as any).payload;
		const ephemeral = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(envelope.ephemeralPublicKey, 'base64')]), format: 'der', type: 'spki' });
		const shared = diffieHellman({ privateKey: pair.privateKey, publicKey: ephemeral });
		const key = Buffer.from(hkdfSync('sha256', shared, 'delivery-1', 'treedx-credential-delivery-v1', 32));
		const decipher = createDecipheriv('chacha20-poly1305', key, Buffer.from(envelope.nonce, 'base64'), { authTagLength: 16 });
		const aad = Buffer.from(['delivery-1', 'push', 'github.com', digest, 'node_local'].join('\n'));
		decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
		const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
		expect(JSON.parse(plaintext.toString())).toMatchObject({ username: 'x-access-token', token: 'github-token' });
		expect(resolveCredential).toHaveBeenCalledWith(expect.objectContaining({ authorityId: 'authority-1', repositoryBindingId: 'repository-1' }));
		expect(store.run).toHaveBeenCalledWith(expect.stringContaining("status = 'consumed'"), expect.any(Array));
	});

	it('rejects a missing or incorrect shared assertion', async () => {
		const { app, resolveCredential } = fixture();
		expect((await request(app, { assertion: 'wrong' }).response).status).toBe(401);
		expect(resolveCredential).not.toHaveBeenCalled();
	});

	it('rejects node, operation, host, or refspec context mismatch', async () => {
		const { app, resolveCredential } = fixture();
		expect((await request(app, { nodeId: 'other-node' }).response).status).toBe(403);
		expect((await request(app, { operation: 'fetch' }).response).status).toBe(403);
		expect((await request(app, { allowedHost: 'example.com' }).response).status).toBe(403);
		expect(resolveCredential).not.toHaveBeenCalled();
	});

	it('rejects expired deliveries before resolving credentials', async () => {
		const { app, resolveCredential } = fixture({ row: { expires_at: new Date(Date.now() - 1_000).toISOString() } });
		expect((await request(app).response).status).toBe(404);
		expect(resolveCredential).not.toHaveBeenCalled();
	});

	it('rejects a replay that loses the atomic consumption claim', async () => {
		const { app } = fixture({ consumed: false });
		expect((await request(app).response).status).toBe(409);
	});
});
