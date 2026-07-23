import {
	assertTreeseedClientEncryptedEscrowMetadata,
	containsTreeseedPlaintextSecretMaterial,
	summarizeTreeseedClientEncryptedEscrowStatus,
} from '@treeseed/sdk/secrets-capability';
import { randomUUID } from 'node:crypto';

function badRequest(message, code = 'invalid_client_encrypted_escrow') {
	const error: Error & Record<string, any> = new Error(message);
	error.status = 400;
	error.code = code;
	return error;
}

function ensureNoPlaintext(input) {
	if (!containsTreeseedPlaintextSecretMaterial(input)) return;
	throw badRequest('Client-encrypted escrow payloads must not include plaintext, passphrases, or derived keys.', 'plaintext_escrow_material');
}

function requireString(value, name) {
	if (typeof value === 'string' && value.trim()) return value.trim();
	throw badRequest(`${name} is required.`);
}

function escrowSummary(record, now) {
	return {
		...record,
		summary: summarizeTreeseedClientEncryptedEscrowStatus(record, now()),
	};
}

export function createClientEncryptedEscrowService({ store, now = () => new Date() }) {
	async function ensureSecretMetadata(input, escrow) {
		const secretId = escrow.secretId;
		const existing = await store.getSecretMetadataRecord(secretId);
		const secretPatch = {
			teamId: input.teamId,
			projectId: input.projectId,
			name: input.name ?? input.secretName ?? secretId,
			secretClass: input.secretClass ?? 'customer_project_secret',
			custodyMode: 'client_encrypted_escrow',
			owner: { kind: 'customer', teamId: input.teamId, projectId: input.projectId },
			status: 'active',
			escrowRecordId: escrow.id,
			apiDecryptable: false,
			plaintextAllowed: false,
			metadata: {
				...(input.secretMetadata ?? {}),
				deploymentIntent: input.deploymentIntent ?? null,
				recoveryPolicy: 'reentry_required',
			},
		};
		if (existing) {
			return store.updateSecretMetadataRecord(secretId, secretPatch);
		}
		return store.createSecretMetadataRecord({
			id: secretId,
			...secretPatch,
		});
	}

	async function getRecord(input: any = {}) {
		const id = requireString(input.escrowId, 'escrowId');
		const record = await store.getClientEncryptedEscrowRecord(id);
		if (!record || record.teamId !== input.teamId || record.projectId !== input.projectId) {
			const error: Error & Record<string, any> = new Error('Client-encrypted escrow record not found.');
			error.status = 404;
			error.code = 'client_encrypted_escrow_not_found';
			throw error;
		}
		return escrowSummary(record, now);
	}

	return {
		async create(input: any = {}) {
			ensureNoPlaintext(input);
			const secretId = input.secretId ?? input.id ?? randomUUID();
			const escrowId = input.escrowId ?? `escrow-${randomUUID()}`;
			const envelope = {
				id: escrowId,
				secretId,
				ciphertext: input.ciphertext ?? null,
				ciphertextRef: input.ciphertextRef ?? `api://projects/${input.projectId}/secrets/escrow/${escrowId}`,
				algorithm: input.algorithm,
				nonce: input.nonce ?? null,
				salt: input.salt ?? null,
				kdf: input.kdf ?? null,
				kdfParams: input.kdfParams ?? null,
				wrappingKeyId: input.wrappingKeyId,
				encryptionVersion: input.encryptionVersion ?? null,
				createdByClientId: input.createdByClientId ?? input.requester?.id ?? null,
				expiresAt: input.expiresAt ?? null,
				deploymentIntent: input.deploymentIntent ?? null,
				metadata: input.metadata ?? {},
			};
			assertTreeseedClientEncryptedEscrowMetadata(envelope);
			const escrow = await store.createClientEncryptedEscrowRecord({
				...envelope,
				teamId: input.teamId,
				projectId: input.projectId,
				status: input.status ?? 'active',
			});
			const secret = await ensureSecretMetadata(input, escrow);
			await store.recordSecretCapabilityAudit('client_encrypted_escrow_record.reentry_policy_selected', {
				teamId: input.teamId,
				projectId: input.projectId,
				secretId,
				escrowRecordId: escrow.id,
				recoveryPolicy: 'reentry_required',
			});
			return { escrow: escrowSummary(escrow, now), secret };
		},

		async list(input: any = {}) {
			const records = await store.listClientEncryptedEscrowRecords({
				teamId: input.teamId,
				projectId: input.projectId,
				secretId: input.secretId,
				status: input.status,
				limit: input.limit,
			});
			return records.map((record) => escrowSummary(record, now));
		},

		async get(input: any = {}) {
			return getRecord(input);
		},

		async update(input: any = {}) {
			ensureNoPlaintext(input);
			const existing = await getRecord(input);
			const patch = {
				...input,
				secretId: existing.secretId,
				ciphertextRef: input.ciphertextRef ?? existing.ciphertextRef,
				algorithm: input.algorithm ?? existing.algorithm,
				wrappingKeyId: input.wrappingKeyId ?? existing.wrappingKeyId,
				metadata: input.metadata ?? existing.metadata,
			};
			assertTreeseedClientEncryptedEscrowMetadata({
				...existing,
				...patch,
			});
			const updated = await store.updateClientEncryptedEscrowRecord(existing.id, patch);
			return escrowSummary(updated, now);
		},

		async migrate(input: any = {}) {
			ensureNoPlaintext(input);
			const existing = await getRecord(input);
			const migratedTo = input.migratedTo ?? 'github_actions_secret_enclave';
			const migrated = await store.migrateClientEncryptedEscrowRecord(existing.id, {
				migratedTo,
				metadata: {
					...(existing.metadata ?? {}),
					migratedBy: input.requester?.id ?? null,
					migratedAt: now().toISOString(),
					migrationTarget: input.migrationTarget ?? null,
				},
			});
			const secretPatch: Record<string, unknown> = {
				custodyMode: migratedTo,
				status: 'active',
				metadata: {
					migratedFromEscrowRecordId: existing.id,
					recoveryPolicy: 'reentry_required',
					migrationTarget: input.migrationTarget ?? null,
				},
			};
			if (migratedTo === 'github_actions_secret_enclave') {
				secretPatch.githubSecretTarget = input.githubSecretTarget ?? input.migrationTarget ?? null;
			}
			const secret = await store.updateSecretMetadataRecord(existing.secretId, secretPatch);
			await store.recordSecretCapabilityAudit('client_encrypted_escrow_record.migrated_to_target', {
				teamId: input.teamId,
				projectId: input.projectId,
				secretId: existing.secretId,
				escrowRecordId: existing.id,
				migratedTo,
				migrationTarget: input.migrationTarget ?? input.githubSecretTarget ?? null,
			});
			return { escrow: escrowSummary(migrated, now), secret };
		},

		async tombstone(input: any = {}) {
			const existing = await getRecord(input);
			const tombstoned = await store.tombstoneClientEncryptedEscrowRecord(existing.id, {
				metadata: {
					...(existing.metadata ?? {}),
					tombstonedBy: input.requester?.id ?? null,
					tombstonedAt: now().toISOString(),
				},
			});
			return escrowSummary(tombstoned, now);
		},
	};
}
