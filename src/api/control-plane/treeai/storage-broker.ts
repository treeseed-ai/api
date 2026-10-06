import { createPublicKey, verify } from 'node:crypto';
import type { Hono } from 'hono';
import { aiStorageProofMessage, aiStorageRequestSchema, type AiStorageProof } from '@treeseed/sdk/deployment';
import { createAiStorageCredentials } from '@treeseed/deployment/security/ai-storage';
import { managedSecretSession, type SecretSession } from '../../../security/managed-secrets.ts';
import { localAiRuntime } from './registered-nodes.ts';
import { aiStorageConnection, storageFailure, withAiStorageCustody } from './storage-binding.ts';
import { CapacityOperationError } from '../repositories/capacity/capacity-operation-error.ts';

function authorizeProof(input: unknown, env: NodeJS.ProcessEnv, now: number): AiStorageProof {
	try {
		const { proof, signature } = aiStorageRequestSchema.parse(input), runtime = localAiRuntime(env);
		if (!runtime || proof.nodeId !== runtime.nodeId || proof.teamId !== runtime.teamId || proof.projectId !== runtime.projectId
			|| proof.issuedAt > now + 5 || now - proof.issuedAt > 30) throw new Error();
		const keys = JSON.parse(env.TREESEED_AI_STORAGE_PUBLIC_KEYS ?? '{}'), pem = keys[proof.service];
		if (typeof pem !== 'string' || !pem.startsWith('-----BEGIN PUBLIC KEY-----') || pem.length > 1024) throw new Error();
		const key = createPublicKey(pem);
		if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(aiStorageProofMessage(proof)), key, Buffer.from(signature, 'base64url'))) throw new Error();
		const ownStore = `managed-${proof.service}`;
		if (proof.storeId !== ownStore && !(proof.service === 'inference' && proof.storeId === 'managed-training' && ['read', 'list'].includes(proof.action))) throw new Error();
		return proof;
	} catch { return storageFailure(401, 'ai_storage_proof_invalid', 'AI storage workload authentication failed.'); }
}

export function createAiStorageBroker(store: any, options: {
	env?: NodeJS.ProcessEnv; session?: SecretSession; mint?: typeof createAiStorageCredentials; fetchImpl?: typeof fetch; now?: () => number;
} = {}) {
	const env = options.env ?? process.env, session = options.session ?? managedSecretSession(env);
	return async (input: unknown) => {
		const now = options.now?.() ?? Math.floor(Date.now() / 1000), proof = authorizeProof(input, env, now);
		await store.ensureInitialized();
		const node = await store.first('SELECT * FROM team_ai_instances WHERE team_id=? AND id=?', [proof.teamId, proof.nodeId]);
		const config = node ? JSON.parse(node.configuration_json) : null;
		if (config?.origin !== 'managed-local' || config.projectId !== proof.projectId
			|| !['both', proof.service].includes(config.purpose)) storageFailure(403, 'ai_storage_node_unavailable', 'AI registration is unavailable for this service.');
		if (!await store.first('SELECT id FROM projects WHERE id=? AND team_id=?', [proof.projectId, proof.teamId]))
			storageFailure(403, 'ai_storage_project_unavailable', 'AI project authority is unavailable.');
		const binding = await store.first("SELECT * FROM team_ai_storage_bindings WHERE team_id=? AND node_id=? AND status='active'", [proof.teamId, proof.nodeId]);
		if (!binding) storageFailure(403, 'ai_storage_binding_unavailable', 'AI storage has not been connected or access was revoked.');
		const connection = await aiStorageConnection(store, proof.teamId, binding.connection_id);
		await store.run('DELETE FROM ai_storage_proof_nonces WHERE expires_at<?', [now]);
		// Atomic per-node issuance budget. This is not a provider storage/spending ceiling.
		const window = Math.floor(now / 60);
		const reserved = await store.first(`WITH allowance AS (
			UPDATE team_ai_storage_bindings SET issuance_count=CASE WHEN issuance_window=? THEN issuance_count+1 ELSE 1 END,issuance_window=?
			WHERE team_id=? AND node_id=? AND version=? AND status='active' AND (issuance_window<>? OR issuance_count<120) RETURNING node_id
		) INSERT INTO ai_storage_proof_nonces (node_id,nonce,expires_at) SELECT node_id,?,? FROM allowance
		ON CONFLICT (node_id,nonce) DO NOTHING RETURNING nonce`, [window, window, proof.teamId, proof.nodeId, binding.version, window, proof.nonce, now + 120]);
		if (!reserved) storageFailure(409, 'ai_storage_proof_unavailable', 'This request was replayed, access changed, or the AI storage request limit was reached.');
		const lease = await withAiStorageCustody(store, proof.teamId, connection, session, async apiToken => {
			const issued = await (options.mint ?? createAiStorageCredentials)({ accountId: connection.nonSecretConfig.accountId, bucket: binding.bucket, apiToken,
				operation: proof }, { fetchImpl: options.fetchImpl });
			const current = await store.first("SELECT * FROM team_ai_storage_bindings WHERE team_id=? AND node_id=? AND status='active'", [proof.teamId, proof.nodeId]);
			const currentConnection = await aiStorageConnection(store, proof.teamId, binding.connection_id);
			if (!current || current.version !== binding.version || currentConnection.version !== connection.version)
				storageFailure(403, 'ai_storage_access_changed', 'AI storage access changed while issuing this operation.');
			return issued;
		});
		await store.recordAuditEvent({ eventType: 'ai.storage.issued', actorType: 'service', actorId: proof.nodeId,
			targetType: 'service_connection', targetId: binding.connection_id,
			data: { teamId: proof.teamId, projectId: proof.projectId, nodeId: proof.nodeId, service: proof.service, action: proof.action, storeId: proof.storeId, expiresAt: lease.expiresAt } });
		return lease;
	};
}

export function installAiStorageBrokerRoute(app: Hono<any>, issue: ReturnType<typeof createAiStorageBroker>) {
	app.post('/v1/internal/ai/storage/credentials', async context => {
		context.header('cache-control', 'no-store');
		try {
			const body = context.req.raw.body; if (!body) return context.json({ ok: false, error: 'AI storage request required.' }, 400);
			const reader = body.getReader(), chunks: Uint8Array[] = []; let size = 0;
			try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength;
				if (size > 4096) return context.json({ ok: false, error: 'AI storage request is too large.' }, 413); chunks.push(value); } }
			finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
			return context.json({ ok: true, result: await issue(JSON.parse(Buffer.concat(chunks).toString('utf8'))) });
		} catch (error) {
			if (error instanceof CapacityOperationError) return context.json({ ok: false, code: error.code, error: error.message }, error.status as 400);
			return context.json({ ok: false, error: 'AI storage operation is unavailable.' }, 503);
		}
	});
}
