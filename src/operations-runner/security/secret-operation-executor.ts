import {
clearServiceVaultKey,
createServiceVaultUserKeyPair,
openSecretOperationPayload,
} from '@treeseed/sdk/secrets-capability';
import type { ControlPlaneStore } from '../../api/persistence/store.ts';
import { validateProviderConnection } from './service-validation.ts';

type KeyEntry = {
	publicKey: string;
	privateKey: Uint8Array;
	expiresAt: string;
};

const keys = new Map<string, KeyEntry>();

function clearEntry(leaseId: string) {
	const entry = keys.get(leaseId);
	if (entry) clearServiceVaultKey(entry.privateKey);
	keys.delete(leaseId);
}

async function prepareLeases(store: ControlPlaneStore) {
	for (const lease of await store.listAwaitingSecretOperationLeases()) {
		const pair = await createServiceVaultUserKeyPair();
		const registered = await store.registerSecretOperationLeaseKey(lease.id, pair.publicKey);
		if (!registered) {
			clearServiceVaultKey(pair.privateKey);
			continue;
		}
		keys.set(lease.id, {
			publicKey: pair.publicKey,
			privateKey: pair.privateKey,
			expiresAt: registered.expiresAt,
		});
	}
}

async function executeReadyLease(store: ControlPlaneStore, leaseId: string, key: KeyEntry) {
	const lease = await store.consumeSecretOperationLease(leaseId);
	if (!lease?.sealedPayload) return;
	const values = await openSecretOperationPayload(lease.sealedPayload, key.publicKey, key.privateKey);
	const keysReceived = Object.keys(values).sort();
	const keysRequired = [...lease.requiredFields].sort();
	if (JSON.stringify(keysReceived) !== JSON.stringify(keysRequired)) {
		throw new Error('The sealed payload fields do not match the authorized operation scope.');
	}
	const connection = await store.getTeamServiceConnection(lease.teamId, lease.connectionId);
	if (!connection) throw new Error('The service connection no longer exists.');
	await validateProviderConnection(connection, values);
	const now = new Date().toISOString();
	await store.run(
		`UPDATE team_service_connections
		 SET status = 'active', last_validated_at = ?, updated_at = ?
		 WHERE team_id = ? AND id = ?`,
		[now, now, lease.teamId, lease.connectionId],
	);
	await store.recordAuditEvent({
		eventType: 'service.connection.validated',
		actorType: 'user',
		actorId: lease.actorUserId,
		targetType: 'team_service_connection',
		targetId: lease.connectionId,
		data: {
			teamId: lease.teamId,
			capabilityType: lease.capabilityType,
			operationCorrelationId: lease.operationCorrelationId,
			validatedAt: now,
		},
	});
}

export async function runSecretOperationExecutor(store: ControlPlaneStore) {
	await prepareLeases(store);
	for (const [leaseId, key] of keys) {
		const lease = await store.first<{ status: string; expires_at: string }>(
			`SELECT status, expires_at FROM secret_operation_leases WHERE id = ?`,
			[leaseId],
		);
		if (!lease || Date.parse(lease.expires_at) <= Date.now() || ['cancelled', 'expired', 'failed', 'consumed'].includes(lease.status)) {
			clearEntry(leaseId);
			continue;
		}
		if (lease.status !== 'ready') continue;
		try {
			await executeReadyLease(store, leaseId, key);
		} catch (error) {
			const now = new Date().toISOString();
			await store.run(
				`UPDATE secret_operation_leases SET status = 'failed', sealed_payload = NULL, updated_at = ? WHERE id = ?`,
				[now, leaseId],
			);
			await store.recordAuditEvent({
				eventType: 'service.connection.validation_failed',
				actorType: 'system',
				targetType: 'secret_operation_lease',
				targetId: leaseId,
				data: { reason: error instanceof Error ? error.message : 'Read-only validation failed.' },
			});
		} finally {
			clearEntry(leaseId);
		}
	}
}
