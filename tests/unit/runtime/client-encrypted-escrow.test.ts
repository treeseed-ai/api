import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { createClientEncryptedEscrowService } from '../../../src/api/client-encrypted-escrow.ts';
import { MarketPostgresDatabase } from '../../../src/api/market-postgres.js';
import { MarketControlPlaneStore } from '../../../src/api/store.js';

const packageRoot = process.cwd();
const marketMigrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market'))
	? resolve(packageRoot, '../sdk/drizzle/market')
	: resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');

function createTestPostgresDatabase() {
	const memory = newDb();
	memory.public.registerFunction({
		name: 'md5',
		args: [DataType.text],
		returns: DataType.text,
		implementation: (value: string) => `md5:${value}`,
	});
	const pg = memory.adapters.createPg();
	return MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot: marketMigrationRoot });
}

function createTestStore() {
	return new MarketControlPlaneStore({
		repoRoot: packageRoot,
		authSecret: 'test-secret',
		baseUrl: 'https://market.example.com',
		siteUrl: 'https://market.example.com',
		issuer: 'https://market.example.com',
		projectId: 'treeseed-market',
		projectApiKey: 'market-project-key',
		projectApiPermissions: ['sdk:execute:global', 'agent:execute:global', 'operations:execute:global'],
		serviceId: 'web',
		serviceSecret: 'web-test-secret',
		assertionSecret: 'web-assertion-secret',
	}, createTestPostgresDatabase());
}

function encryptedEnvelope(patch: Record<string, unknown> = {}) {
	return {
		teamId: 'team-1',
		projectId: 'project-1',
		escrowId: 'escrow-1',
		secretId: 'secret-1',
		name: 'TREESEED_PROJECT_SECRET',
		secretClass: 'customer_project_secret',
		ciphertext: 'base64-ciphertext',
		ciphertextRef: 'api://projects/project-1/secrets/escrow/escrow-1',
		algorithm: 'xchacha20-poly1305',
		nonce: 'base64-nonce',
		salt: 'base64-salt',
		kdf: 'argon2id',
		kdfParams: { memoryKiB: 65536, iterations: 3, parallelism: 1 },
		wrappingKeyId: 'client-key-1',
		encryptionVersion: 'v1',
		createdByClientId: 'cli',
		expiresAt: '2026-07-17T00:00:00.000Z',
		deploymentIntent: {
			targetMode: 'github_actions_secret_enclave',
			repository: 'treeseed-ai/project',
			environment: 'production',
			secretName: 'TREESEED_PROJECT_SECRET',
		},
		...patch,
	};
}

describe('client-encrypted escrow primitives', () => {
	it('creates, lists, reads, updates, migrates, and tombstones ciphertext-only escrow records', async () => {
		const store = createTestStore();
		const service = createClientEncryptedEscrowService({
			store,
			now: () => new Date('2026-06-17T00:00:00.000Z'),
		});

		const created = await service.create(encryptedEnvelope());
		expect(created.escrow).toMatchObject({
			id: 'escrow-1',
			ciphertext: 'base64-ciphertext',
			status: 'active',
			summary: { escrowed: true, reentryRequired: false },
		});
		expect(created.secret).toMatchObject({
			id: 'secret-1',
			custodyMode: 'client_encrypted_escrow',
			apiDecryptable: false,
			plaintextAllowed: false,
			escrowRecordId: 'escrow-1',
		});

		const listed = await service.list({ teamId: 'team-1', projectId: 'project-1' });
		expect(listed).toHaveLength(1);
		const read = await service.get({ teamId: 'team-1', projectId: 'project-1', escrowId: 'escrow-1' });
		expect(read).toMatchObject({ id: 'escrow-1', ciphertextRef: 'api://projects/project-1/secrets/escrow/escrow-1' });

		const updated = await service.update({
			teamId: 'team-1',
			projectId: 'project-1',
			escrowId: 'escrow-1',
			ciphertext: 'rotated-base64-ciphertext',
			ciphertextRef: 'api://projects/project-1/secrets/escrow/escrow-1',
			algorithm: 'xchacha20-poly1305',
			nonce: 'rotated-base64-nonce',
			salt: 'rotated-base64-salt',
			kdf: 'argon2id',
			kdfParams: { memoryKiB: 65536, iterations: 4, parallelism: 1 },
			wrappingKeyId: 'client-key-1',
			encryptionVersion: 'v1',
		});
		expect(updated).toMatchObject({
			ciphertext: 'rotated-base64-ciphertext',
			nonce: 'rotated-base64-nonce',
		});

		const migrated = await service.migrate({
			teamId: 'team-1',
			projectId: 'project-1',
			escrowId: 'escrow-1',
			migratedTo: 'github_actions_secret_enclave',
			githubSecretTarget: {
				repository: 'treeseed-ai/project',
				environment: 'production',
				secretName: 'TREESEED_PROJECT_SECRET',
				scope: 'environment',
			},
		});
		expect(migrated.escrow).toMatchObject({
			status: 'migrated',
			migratedTo: 'github_actions_secret_enclave',
			summary: { escrowed: false, migrated: true },
		});
		expect(migrated.secret).toMatchObject({
			custodyMode: 'github_actions_secret_enclave',
			githubSecretTarget: {
				repository: 'treeseed-ai/project',
				environment: 'production',
				secretName: 'TREESEED_PROJECT_SECRET',
			},
		});

		const tombstoned = await service.tombstone({ teamId: 'team-1', projectId: 'project-1', escrowId: 'escrow-1' });
		expect(tombstoned).toMatchObject({
			status: 'tombstoned',
			summary: { escrowed: false, tombstoned: true },
		});

		const auditEvents = await store.listAuditEventsForTarget('project', 'project-1', 50);
		expect(auditEvents.map((event: any) => event.eventType)).toEqual(expect.arrayContaining([
			'client_encrypted_escrow_record.created',
			'client_encrypted_escrow_record.reentry_policy_selected',
			'client_encrypted_escrow_record.migrated_to_target',
			'client_encrypted_escrow_record.tombstoned',
		]));
		expect(JSON.stringify(auditEvents)).not.toContain('do-not-store');
		expect(JSON.stringify(auditEvents)).not.toContain('passphrase');
	});

	it('rejects plaintext-looking escrow payloads before persistence', async () => {
		const store = createTestStore();
		const service = createClientEncryptedEscrowService({ store });
		await expect(service.create(encryptedEnvelope({
			passphrase: 'do-not-store',
		}))).rejects.toMatchObject({ code: 'plaintext_escrow_material' });
		await expect(store.getClientEncryptedEscrowRecord('escrow-1')).resolves.toBeNull();
	});

	it('marks expired active escrow as re-entry required', async () => {
		const store = createTestStore();
		const service = createClientEncryptedEscrowService({
			store,
			now: () => new Date('2026-06-17T00:00:00.000Z'),
		});
		const created = await service.create(encryptedEnvelope({
			escrowId: 'escrow-expired',
			expiresAt: '2026-01-01T00:00:00.000Z',
		}));
		expect(created.escrow.summary).toMatchObject({
			status: 'reentry_required',
			expired: true,
			reentryRequired: true,
		});
	});
});
