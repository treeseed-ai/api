import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolveGitHubCredentialAuthority } from '../../../../security/provider-credential-authority.ts';
import { prepareTreeDxCredentialDelivery } from './treedx-credential-delivery-preparation.ts';

function sameSecret(left: string, right: string) {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}

function deliveryAssociatedData(input: { deliveryId: string; operation: string; allowedHost: string; refspecDigest: string; nodeId: string }) {
	return Buffer.from([input.deliveryId, input.operation, input.allowedHost, input.refspecDigest, input.nodeId].join('\n'));
}

export function deliveryScopeMatches(delivery: any, requested: any) {
	return requested.allowedHost === delivery.allowed_host
		&& requested.refspecDigest === delivery.refspec_digest
		&& requested.operation === delivery.operation_kind;
}

export function sealCredential(nodePublicKey: string, credential: Record<string, unknown>, scope: {
	deliveryId: string; operation: string; allowedHost: string; refspecDigest: string; nodeId: string;
}) {
	const rawNodeKey = Buffer.from(nodePublicKey, 'base64');
	if (rawNodeKey.length !== 32) throw new Error('TreeDX supplied an invalid ephemeral encryption key.');
	const nodeKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), rawNodeKey]), format: 'der', type: 'spki' });
	const ephemeral = generateKeyPairSync('x25519');
	const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: nodeKey });
	const key = Buffer.from(hkdfSync('sha256', shared, Buffer.from(scope.deliveryId), Buffer.from('treedx-credential-delivery-v1'), 32));
	const nonce = randomBytes(12); const aad = deliveryAssociatedData(scope); const plaintext = JSON.stringify(credential);
	const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
	cipher.setAAD(aad, { plaintextLength: Buffer.byteLength(plaintext) });
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const ephemeralDer = ephemeral.publicKey.export({ format: 'der', type: 'spki' });
	key.fill(0); shared.fill(0);
	return { algorithm: 'x25519-hkdf-sha256-chacha20-poly1305/v1',
		ephemeralPublicKey: Buffer.from(ephemeralDer).subarray(-32).toString('base64'), nonce: nonce.toString('base64'),
		ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

export function installTreedxCredentialsMirrorsAndSharesRoutes(context: any) {
	const { app, jsonError, requirePlatformRunner, requireTeamAccess, store, runtime } = context;
	app.post('/v1/internal/treedx/credential-deliveries/prepare', async (c: any) => {
		const access = await requirePlatformRunner(c, runtime.resolved.config);
		if (access.response) return access.response;
		try {
			const payload = await prepareTreeDxCredentialDelivery({
				store, body: await c.req.json().catch(() => ({})), env: process.env,
				fetchImpl: runtime?.resolved?.config?.fetchImpl,
			});
			c.header('cache-control', 'private, no-store');
			return c.json({ ok: true, payload });
		} catch (error: any) {
			return jsonError(c, error?.status ?? 500, error instanceof Error ? error.message : 'Credential delivery preparation failed.',
				{ code: error?.code ?? 'credential_delivery_preparation_failed' });
		}
	});
	app.post('/v1/internal/credential-deliveries/consume', async (c: any) => {
		const expected = String(runtime?.resolved?.config?.TREESEED_TREEDX_CREDENTIAL_BROKER_ASSERTION
			?? process.env.TREESEED_TREEDX_CREDENTIAL_BROKER_ASSERTION ?? '');
		const authorization = String(c.req.header('authorization') ?? '');
		const assertion = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
		if (!expected || !sameSecret(assertion, expected)) return jsonError(c, 401, 'Credential delivery authorization failed.');
		const nodeId = String(c.req.header('x-treedx-node-id') ?? '');
		const body = await c.req.json().catch(() => ({}));
		const deliveryId = String(body.deliveryId ?? '');
		const delivery = await store.first(
			`SELECT d.*, g.credential_authority_id, g.repository_binding_id
			 FROM remote_credential_deliveries d JOIN remote_git_operation_grants g ON g.id = d.grant_id
			 WHERE d.id = ?`, [deliveryId],
		);
		if (!delivery || delivery.node_id !== nodeId || delivery.status !== 'ready' || delivery.delivery_mode !== 'sealed'
			|| Date.parse(delivery.expires_at) <= Date.now()) return jsonError(c, 404, 'Credential delivery is unavailable.');
		if (delivery.allowed_host !== 'github.com') return jsonError(c, 403, 'Credential delivery host is not permitted.');
		if (!deliveryScopeMatches(delivery, body)) return jsonError(c, 403, 'Credential delivery scope does not match the Git operation.');
		const now = new Date().toISOString();
		const consumed: any = await store.run(
			`UPDATE remote_credential_deliveries SET status = 'consumed', consumed_at = ?, updated_at = ?
			 WHERE id = ? AND node_id = ? AND status = 'ready' AND expires_at > ?`,
			[now, now, deliveryId, nodeId, now],
		);
		if (Number(consumed?.meta?.changes ?? 0) !== 1) return jsonError(c, 409, 'Credential delivery was already consumed.');
		try {
			const credential = await resolveGitHubCredentialAuthority({
				store, authorityId: delivery.credential_authority_id,
				repositoryBindingId: delivery.repository_binding_id, capability: 'repository-hosting',
				fetchImpl: runtime?.resolved?.config?.fetchImpl,
			});
			await store.run(`UPDATE remote_git_operation_grants SET status = 'consumed', updated_at = ? WHERE id = ?`, [now, delivery.grant_id]);
			await store.recordAuditEvent({ eventType: 'provider.credential.delivered', actorType: 'service', actorId: nodeId,
				targetType: 'remote_credential_delivery', targetId: deliveryId,
				data: { operationId: delivery.operation_id, repositoryBindingId: delivery.repository_binding_id,
					authorityScheme: credential.authorityScheme, expiresAt: credential.expiresAt } });
			c.header('cache-control', 'private, no-store');
			return c.json({ ok: true, payload: sealCredential(String(body.nodePublicKey ?? ''),
				{ type: 'token', username: credential.username, token: credential.token, expiresAt: credential.expiresAt },
				{ deliveryId, operation: body.operation, allowedHost: body.allowedHost, refspecDigest: body.refspecDigest, nodeId }) });
		} catch (error) {
			await store.run(`UPDATE remote_credential_deliveries SET status = 'failed', updated_at = ? WHERE id = ?`, [now, deliveryId]);
			await store.run(`UPDATE remote_git_operation_grants SET status = 'failed', updated_at = ? WHERE id = ?`, [now, delivery.grant_id]);
			return jsonError(c, 409, error instanceof Error ? error.message : 'Credential authority failed.');
		}
	});
	
	app.get('/v1/teams/:teamId/treedx/mirrors', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.listTreeDxMirrors(c.req.param('teamId')) });
				});
	
	app.post('/v1/teams/:teamId/treedx/mirrors', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const mirror = await store.createTreeDxMirror(c.req.param('teamId'), body);
					if (!mirror) return jsonError(c, 404, 'Create a team TreeDX binding before adding mirrors.');
					return c.json({ ok: true, payload: mirror }, { status: 201 });
				});
	
	app.post('/v1/teams/:teamId/treedx/mirrors/:mirrorId/sync', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const mirror = await store.syncTreeDxMirror(c.req.param('teamId'), c.req.param('mirrorId'), body);
					if (!mirror) return jsonError(c, 404, 'Unknown TreeDX mirror.');
					return c.json({ ok: true, payload: mirror });
				});
	
	app.get('/v1/teams/:teamId/treedx/shares', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.listTreeDxShares(c.req.param('teamId')) });
				});
	
	app.post('/v1/teams/:teamId/treedx/shares', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const share = await store.createTreeDxShare(c.req.param('teamId'), body);
					return c.json({ ok: true, payload: share }, { status: 201 });
				});
}
