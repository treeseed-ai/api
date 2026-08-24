import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import { resolveGitHubCredentialAuthority } from '../../../security/provider-credential-authority.ts';

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const DIGEST = /^[a-f0-9]{64}$/u;
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;

type Store = {
	first(query: string, parameters?: unknown[]): Promise<any>;
	run(query: string, parameters?: unknown[]): Promise<unknown>;
};

type Credential = { token: string; username?: string; expiresAt?: string | null; authorityScheme?: string };
type ResolveCredential = typeof resolveGitHubCredentialAuthority;

function sameSecret(left: string, right: string) {
	const leftBuffer = Buffer.from(left), rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function requestBody(value: unknown) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_request');
	const body = value as Record<string, unknown>;
	const deliveryId = String(body.deliveryId ?? ''), nodePublicKey = String(body.nodePublicKey ?? '');
	const operation = String(body.operation ?? ''), allowedHost = String(body.allowedHost ?? '').toLowerCase();
	const refspecDigest = String(body.refspecDigest ?? '').toLowerCase();
	const publicKey = Buffer.from(nodePublicKey, 'base64');
	if (!deliveryId || publicKey.length !== 32 || !operation || !HOST.test(allowedHost) || !DIGEST.test(refspecDigest)) throw new Error('invalid_request');
	return { deliveryId, publicKey, operation, allowedHost, refspecDigest };
}

export function sealTreeDxCredential(input: {
	deliveryId: string; nodeId: string; publicKey: Buffer; operation: string; allowedHost: string; refspecDigest: string; credential: Credential;
}) {
	const recipient = createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, input.publicKey]), format: 'der', type: 'spki' });
	const ephemeral = generateKeyPairSync('x25519');
	const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
	const key = Buffer.from(hkdfSync('sha256', shared, input.deliveryId, 'treedx-credential-delivery-v1', 32));
	const nonce = randomBytes(12);
	const plaintext = Buffer.from(JSON.stringify({ username: input.credential.username ?? 'x-access-token', token: input.credential.token,
		expiresAt: input.credential.expiresAt ?? null, authorityScheme: input.credential.authorityScheme ?? null }));
	const aad = Buffer.from([input.deliveryId, input.operation, input.allowedHost, input.refspecDigest, input.nodeId].join('\n'));
	const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
	cipher.setAAD(aad, { plaintextLength: plaintext.length });
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const ephemeralPublicKey = ephemeral.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
	return { algorithm: 'x25519-hkdf-sha256-chacha20-poly1305/v1', ephemeralPublicKey: ephemeralPublicKey.toString('base64'),
		nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

export function installRemoteCredentialBrokerRoute(app: Hono<any>, options: {
	store: Store; assertion?: string; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; resolveCredential?: ResolveCredential;
}) {
	app.post('/v1/internal/credential-deliveries/consume', async (context) => {
		const configuredAssertion = options.assertion ?? options.env?.TREESEED_TREEDX_CREDENTIAL_BROKER_ASSERTION
			?? process.env.TREESEED_TREEDX_CREDENTIAL_BROKER_ASSERTION ?? '';
		const authorization = context.req.header('authorization')?.match(/^Bearer\s+(.+)$/iu)?.[1] ?? '';
		const nodeId = context.req.header('x-treedx-node-id')?.trim() ?? '';
		if (!configuredAssertion || !authorization || !sameSecret(authorization, configuredAssertion) || !nodeId) {
			return context.json({ ok: false, error: 'Credential broker authentication failed.' }, 401);
		}
		try {
			const body = requestBody(await context.req.json());
			const row = await options.store.first(`SELECT d.*, g.repository_binding_id, g.credential_authority_id,
				g.treedx_node_id, g.status AS grant_status FROM remote_credential_deliveries d
				JOIN remote_git_operation_grants g ON g.id = d.grant_id WHERE d.id = ?`, [body.deliveryId]);
			if (!row || row.status !== 'ready' || row.grant_status !== 'delivered' || Date.parse(row.expires_at) <= Date.now()) {
				return context.json({ ok: false, error: 'Credential delivery is unavailable.' }, 404);
			}
			if (row.node_id !== nodeId || row.treedx_node_id !== nodeId || row.operation_kind !== body.operation
				|| row.allowed_host !== body.allowedHost || row.refspec_digest !== body.refspecDigest) {
				return context.json({ ok: false, error: 'Credential delivery context does not match.' }, 403);
			}
			const resolveCredential = options.resolveCredential ?? resolveGitHubCredentialAuthority;
			const credential = await resolveCredential({ store: options.store, authorityId: row.credential_authority_id,
				repositoryBindingId: row.repository_binding_id, capability: 'repository-hosting', env: options.env, fetchImpl: options.fetchImpl });
			const payload = sealTreeDxCredential({ ...body, nodeId, credential });
			const consumed = await options.store.first(`UPDATE remote_credential_deliveries SET status = 'consumed', consumed_at = ?, updated_at = ?
				WHERE id = ? AND status = 'ready' AND expires_at > ? RETURNING id`,
				[new Date().toISOString(), new Date().toISOString(), body.deliveryId, new Date().toISOString()]);
			if (!consumed) return context.json({ ok: false, error: 'Credential delivery was already consumed.' }, 409);
			await options.store.run("UPDATE remote_git_operation_grants SET status = 'consumed', updated_at = ? WHERE id = ? AND status = 'delivered'",
				[new Date().toISOString(), row.grant_id]);
			return context.json({ ok: true, payload });
		} catch (error) {
			if (error instanceof Error && error.message === 'invalid_request') return context.json({ ok: false, error: 'Credential delivery request is invalid.' }, 400);
			return context.json({ ok: false, error: 'Credential delivery could not be consumed.' }, 503);
		}
	});
}
