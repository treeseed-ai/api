import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
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

describe('secrets capability persistence', () => {
	it('persists secret metadata, escrow records, and audit events without plaintext', async () => {
		const store = createTestStore();
		const escrow = await store.createClientEncryptedEscrowRecord({
			id: 'escrow-1',
			teamId: 'team-1',
			projectId: 'project-1',
			secretId: 'secret-1',
			ciphertextRef: 'local://draft-host/secret-1',
			algorithm: 'xchacha20-poly1305',
			wrappingKeyId: 'client-key-1',
			metadata: { purpose: 'draft-host-config' },
		});
		expect(escrow).toMatchObject({
			id: 'escrow-1',
			status: 'active',
			ciphertextRef: 'local://draft-host/secret-1',
		});

		const secret = await store.createSecretMetadataRecord({
			id: 'secret-1',
			teamId: 'team-1',
			projectId: 'project-1',
			name: 'TREESEED_REPOSITORY_WRITE',
			secretClass: 'repository_access',
			custodyMode: 'client_encrypted_escrow',
			owner: { kind: 'customer', teamId: 'team-1', projectId: 'project-1' },
			escrowRecordId: escrow.id,
			metadata: { source: 'config-draft' },
		});
		expect(secret).toMatchObject({
			id: 'secret-1',
			apiDecryptable: false,
			plaintextAllowed: false,
			escrowRecordId: 'escrow-1',
		});

		const migrated = await store.migrateClientEncryptedEscrowRecord(escrow.id, {
			migratedTo: 'github_actions_secret_enclave',
			metadata: { migratedBy: 'test' },
		});
		expect(migrated).toMatchObject({ status: 'migrated', migratedTo: 'github_actions_secret_enclave' });

		const tombstoned = await store.tombstoneSecretMetadataRecord(secret.id);
		expect(tombstoned).toMatchObject({ status: 'tombstoned' });

		const auditEvents = await store.listAuditEventsForTarget('project', 'project-1', 20);
		expect(auditEvents.map((event: any) => event.eventType)).toEqual(expect.arrayContaining([
			'client_encrypted_escrow_record.created',
			'secret_metadata_record.created',
			'secret_metadata_record.tombstoned',
		]));
		expect(JSON.stringify({ secret, escrow, migrated, tombstoned, auditEvents })).not.toContain('do-not-store');
	});

	it('rejects service-decryptable customer secrets and plaintext-bearing payloads', async () => {
		const store = createTestStore();
		await expect(store.createSecretMetadataRecord({
			id: 'bad-secret',
			teamId: 'team-1',
			projectId: 'project-1',
			name: 'PRIVATE_REPO_WRITE',
			secretClass: 'repository_access',
			custodyMode: 'github_actions_secret_enclave',
			owner: { kind: 'customer', teamId: 'team-1', projectId: 'project-1' },
			apiDecryptable: true,
			githubSecretTarget: {
				repository: 'treeseed-ai/project',
				environment: 'production',
				secretName: 'PRIVATE_REPO_WRITE',
				scope: 'environment',
			},
		})).rejects.toMatchObject({ code: 'api_decryptable_customer_secret' });

		await expect(store.createClientEncryptedEscrowRecord({
			id: 'bad-escrow',
			teamId: 'team-1',
			projectId: 'project-1',
			secretId: 'secret-1',
			ciphertextRef: 'local://draft-host/secret-1',
			algorithm: 'xchacha20-poly1305',
			wrappingKeyId: 'client-key-1',
			plaintext: 'do-not-store',
		})).rejects.toMatchObject({ code: 'plaintext_escrow_material' });
	});

	it('tracks GitHub grants, workflow records, dispatch records, and TreeDX issuance evidence fail-closed', async () => {
		const store = createTestStore();
		const grant = await store.upsertGitHubRepositoryGrant({
			id: 'grant-1',
			teamId: 'team-1',
			projectId: 'project-1',
			repository: 'treeseed-ai/project',
			installationId: '123',
			status: 'active',
			permissions: { contents: 'write', actions: 'write', secrets: 'write' },
			environments: ['production'],
		});
		expect(grant).toMatchObject({ status: 'active', repository: 'treeseed-ai/project' });
		const drifted = await store.updateGitHubRepositoryGrantStatus(grant.id, 'drifted', {
			driftCode: 'github_environment_missing',
		});
		expect(drifted).toMatchObject({ status: 'drifted', driftCode: 'github_environment_missing' });

		const operation = await store.upsertWorkflowOperationRecord({
			id: 'workflow-op-1',
			teamId: 'team-1',
			projectId: 'project-1',
			name: 'Repository Save',
			repository: 'treeseed-ai/project',
			workflowFile: '.github/workflows/treeseed-secret-operation.yml',
			secretBearing: true,
			trustedExecutionSetId: 'trusted-release',
			dispatch: { mode: 'allowlisted', arbitraryDispatch: false },
			secretClasses: ['repository_access'],
			providerSuppliedCommandsAllowed: false,
			trustPolicy: {
				protectedRefs: ['refs/heads/main'],
				protectedEnvironments: ['production'],
				allowedWorkflowFiles: ['.github/workflows/treeseed-secret-operation.yml'],
				artifactPolicy: 'metadata_only',
				outputObservation: 'status_only',
			},
		});
		expect(operation).toMatchObject({ status: 'active', secretBearing: true });

		await expect(store.upsertWorkflowOperationRecord({
			id: 'workflow-op-bad',
			teamId: 'team-1',
			projectId: 'project-1',
			name: 'Unsafe',
			repository: 'treeseed-ai/project',
			workflowFile: '.github/workflows/unsafe.yml',
			secretBearing: true,
			trustedExecutionSetId: 'trusted-release',
			dispatch: { mode: 'arbitrary', arbitraryDispatch: true },
			providerSuppliedCommandsAllowed: true,
		})).rejects.toMatchObject({ code: 'arbitrary_secret_workflow_dispatch' });

		const dispatch = await store.createWorkflowDispatchRecord({
			id: 'dispatch-1',
			teamId: 'team-1',
			projectId: 'project-1',
			workflowOperationId: operation.id,
			platformOperationId: 'platform-op-1',
			repository: operation.repository,
			workflowFile: operation.workflowFile,
			ref: 'refs/heads/main',
			inputs: { planId: 'plan-1' },
		});
		expect(dispatch).toMatchObject({
			status: 'queued',
			workflowOperationId: operation.id,
			platformOperationId: 'platform-op-1',
		});

		const issuance = await store.recordTreeDxCredentialIssuance({
			id: 'issuance-1',
			teamId: 'team-1',
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			repository: 'treeseed-ai/project',
			credentialProvider: 'github-app',
			tokenPrefix: 'ghs_1234',
			tokenHash: 'sha256:token-hash',
			scopes: ['contents:write'],
			allowedOperations: ['clone', 'fetch', 'save', 'commit', 'push'],
		});
		expect(issuance).toMatchObject({
			status: 'issued',
			tokenPrefix: 'ghs_1234',
			tokenHash: 'sha256:token-hash',
		});
		expect(JSON.stringify(issuance)).not.toContain('plain-token');

		await expect(store.recordTreeDxCredentialIssuance({
			id: 'bad-issuance',
			teamId: 'team-1',
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			repository: 'treeseed-ai/project',
			credentialProvider: 'github-app',
			token: 'plain-token',
		})).rejects.toMatchObject({ code: 'plaintext_escrow_material' });

		const auditEvents = await store.listAuditEventsForTarget('project', 'project-1', 50);
		expect(auditEvents.map((event: any) => event.eventType)).toEqual(expect.arrayContaining([
			'github_repository_grant.upserted',
			'github_repository_grant.drifted',
			'workflow_operation_record.upserted',
			'workflow_dispatch_record.created',
			'treedx_credential_issuance_record.created',
		]));
	});
});
