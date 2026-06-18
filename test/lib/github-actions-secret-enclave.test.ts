import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { createGitHubActionsSecretEnclave } from '../../src/api/github-actions-secret-enclave.ts';
import { MarketPostgresDatabase } from '../../src/api/market-postgres.js';
import { MarketControlPlaneStore } from '../../src/api/store.js';

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

function fakeGithubAppAdapter(calls: any[] = []) {
	return {
		mintInstallationToken: async (input: any) => {
			calls.push(input);
			return {
				token: 'ghs_transient_token',
				expiresAt: '2026-06-17T22:30:00.000Z',
				permissions: input.requiredPermissions,
				issuance: { id: 'issuance-1' },
			};
		},
	};
}

function fakeGithubClient(requests: any[] = []) {
	return {
		request: async (route: string, params: any) => {
			requests.push({ route, params });
			if (route.includes('public-key')) {
				return { data: { key_id: 'key-1', key: 'base64-public-key' } };
			}
			return { status: 204 };
		},
	};
}

async function seedWorkflowOperation(store: any, patch: Record<string, unknown> = {}) {
	return store.upsertWorkflowOperationRecord({
		id: 'secret-op-1',
		teamId: 'team-1',
		projectId: 'project-1',
		name: 'Secret Operation',
		repository: 'treeseed-ai/project',
		workflowFile: '.github/workflows/treeseed-secret-operation.yml',
		secretBearing: true,
		trustedExecutionSetId: 'trusted-release',
		dispatch: { mode: 'allowlisted', arbitraryDispatch: false },
		inputs: [{ name: 'planId', required: true, allowedValues: ['plan-1'] }],
		secretClasses: ['customer_project_secret'],
		providerSuppliedCommandsAllowed: false,
		trustPolicy: {
			protectedRefs: ['refs/heads/main'],
			protectedEnvironments: ['production'],
			allowedWorkflowFiles: ['.github/workflows/treeseed-secret-operation.yml'],
			artifactPolicy: 'metadata_only',
			timeoutSeconds: 30,
			outputObservation: 'status_only',
		},
		...patch,
	});
}

describe('GitHub Actions secret enclave', () => {
	it('fetches GitHub Actions public keys through GitHub App authority and audits metadata only', async () => {
		const store = createTestStore();
		const tokenCalls: any[] = [];
		const githubRequests: any[] = [];
		const enclave = createGitHubActionsSecretEnclave({
			store,
			githubAppAdapter: fakeGithubAppAdapter(tokenCalls),
			githubClientFactory: () => fakeGithubClient(githubRequests),
			now: () => new Date('2026-06-17T21:30:00.000Z'),
		});

		const key = await enclave.fetchPublicKey({
			teamId: 'team-1',
			projectId: 'project-1',
			installationId: '99',
			repository: 'treeseed-ai/project',
			scope: 'environment',
			environment: 'production',
		});

		expect(key).toMatchObject({
			repository: 'treeseed-ai/project',
			scope: 'environment',
			environment: 'production',
			keyId: 'key-1',
			key: 'base64-public-key',
		});
		expect(tokenCalls[0]).toMatchObject({
			requiredPermissions: { metadata: 'read', secrets: 'write', environments: 'read' },
		});
		expect(githubRequests[0]).toMatchObject({
			route: 'GET /repos/{owner}/{repo}/environments/{environment_name}/secrets/public-key',
		});
		const audit = await store.listAuditEventsForTarget('project', 'project-1', 20);
		expect(JSON.stringify(audit)).not.toContain('ghs_transient_token');
	});

	it('deploys only GitHub-encrypted secret payloads and updates secret metadata', async () => {
		const store = createTestStore();
		const githubRequests: any[] = [];
		const enclave = createGitHubActionsSecretEnclave({
			store,
			githubAppAdapter: fakeGithubAppAdapter(),
			githubClientFactory: () => fakeGithubClient(githubRequests),
			now: () => new Date('2026-06-17T21:30:00.000Z'),
		});

		const result = await enclave.deployEncryptedSecret({
			teamId: 'team-1',
			projectId: 'project-1',
			installationId: '99',
			secretId: 'secret-1',
			repository: 'treeseed-ai/project',
			scope: 'environment',
			environment: 'production',
			secretName: 'TREESEED_PROJECT_SECRET',
			encryptedValue: 'github-sealed-value',
			keyId: 'key-1',
		});

		expect(githubRequests[0]).toMatchObject({
			route: 'PUT /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}',
			params: expect.objectContaining({
				secret_name: 'TREESEED_PROJECT_SECRET',
				encrypted_value: 'github-sealed-value',
				key_id: 'key-1',
			}),
		});
		expect(result.secret).toMatchObject({
			id: 'secret-1',
			custodyMode: 'github_actions_secret_enclave',
			apiDecryptable: false,
			plaintextAllowed: false,
			githubSecretTarget: {
				repository: 'treeseed-ai/project',
				environment: 'production',
				secretName: 'TREESEED_PROJECT_SECRET',
				scope: 'environment',
			},
		});
	});

	it('rejects plaintext secret deployment payloads before GitHub calls', async () => {
		const store = createTestStore();
		const githubRequests: any[] = [];
		const enclave = createGitHubActionsSecretEnclave({
			store,
			githubAppAdapter: fakeGithubAppAdapter(),
			githubClientFactory: () => fakeGithubClient(githubRequests),
		});

		await expect(enclave.deployEncryptedSecret({
			teamId: 'team-1',
			projectId: 'project-1',
			installationId: '99',
			repository: 'treeseed-ai/project',
			scope: 'environment',
			environment: 'production',
			secretName: 'TREESEED_PROJECT_SECRET',
			encryptedValue: 'github-sealed-value',
			keyId: 'key-1',
			secretValue: 'do-not-store',
		})).rejects.toMatchObject({ code: 'plaintext_escrow_material' });
		expect(githubRequests).toEqual([]);
	});

	it('dispatches workflow operations only by allowlisted operation id and records dispatch evidence', async () => {
		const store = createTestStore();
		await seedWorkflowOperation(store);
		const dispatched: any[] = [];
		const enclave = createGitHubActionsSecretEnclave({
			store,
			githubAppAdapter: fakeGithubAppAdapter(),
			workflowDispatcher: async (input) => {
				dispatched.push(input);
				return { ok: true, plans: [], result: { runId: 123, status: 'queued' } };
			},
			now: () => new Date('2026-06-17T21:30:00.000Z'),
		});

		const result = await enclave.dispatchWorkflowOperation({
			teamId: 'team-1',
			projectId: 'project-1',
			installationId: '99',
			operationId: 'secret-op-1',
			ref: 'refs/heads/main',
			environment: 'production',
			inputs: { planId: 'plan-1' },
		});

		expect(dispatched[0].unit).toMatchObject({
			unitType: 'github-workflow-dispatch',
			spec: {
				repository: 'treeseed-ai/project',
				workflow: '.github/workflows/treeseed-secret-operation.yml',
				branch: 'main',
				inputs: { planId: 'plan-1' },
			},
		});
		expect(result.dispatch).toMatchObject({
			status: 'dispatched',
			workflowOperationId: 'secret-op-1',
			repository: 'treeseed-ai/project',
			workflowFile: '.github/workflows/treeseed-secret-operation.yml',
		});
		const record = await store.getWorkflowDispatchRecord(result.dispatch.id);
		expect(JSON.stringify(record)).not.toContain('ghs_transient_token');
	});

	it('fails closed for arbitrary workflow dispatch, untrusted refs, missing environments, and schema-invalid inputs', async () => {
		const store = createTestStore();
		await seedWorkflowOperation(store);
		const enclave = createGitHubActionsSecretEnclave({
			store,
			githubAppAdapter: fakeGithubAppAdapter(),
			workflowDispatcher: async () => {
				throw new Error('dispatcher should not run');
			},
		});

		await expect(enclave.dispatchWorkflowOperation({
			teamId: 'team-1',
			projectId: 'project-1',
			installationId: '99',
			operationId: 'secret-op-1',
			ref: 'refs/heads/feature',
			environment: 'production',
			inputs: { planId: 'plan-1' },
		})).rejects.toMatchObject({ code: 'workflow_trust_drift' });

		await expect(enclave.dispatchWorkflowOperation({
			teamId: 'team-1',
			projectId: 'project-1',
			installationId: '99',
			operationId: 'secret-op-1',
			ref: 'refs/heads/main',
			inputs: { planId: 'plan-1' },
		})).rejects.toMatchObject({ code: 'github_environment_missing' });

		await expect(enclave.dispatchWorkflowOperation({
			teamId: 'team-1',
			projectId: 'project-1',
			installationId: '99',
			operationId: 'secret-op-1',
			ref: 'refs/heads/main',
			environment: 'production',
			inputs: { planId: 'plan-2' },
		})).rejects.toMatchObject({ code: 'workflow_dispatch_blocked' });

		await store.upsertWorkflowOperationRecord({
			id: 'unsafe-op',
			teamId: 'team-1',
			projectId: 'project-1',
			name: 'Unsafe',
			repository: 'treeseed-ai/project',
			workflowFile: '.github/workflows/unsafe.yml',
			secretBearing: true,
			trustedExecutionSetId: 'trusted-release',
			dispatch: { mode: 'arbitrary', arbitraryDispatch: true },
			providerSuppliedCommandsAllowed: true,
		}).catch((error: unknown) => error);
		expect(await store.getWorkflowOperationRecord('unsafe-op')).toBeNull();

		await store.upsertWorkflowOperationRecord({
			id: 'unsafe-local-action-op',
			teamId: 'team-1',
			projectId: 'project-1',
			name: 'Unsafe Local Action',
			repository: 'treeseed-ai/project',
			workflowFile: '.github/workflows/unsafe-local-action.yml',
			secretBearing: true,
			trustedExecutionSetId: 'trusted-release',
			dispatch: { mode: 'allowlisted', arbitraryDispatch: false },
			providerSuppliedCommandsAllowed: false,
			trustPolicy: {
				protectedRefs: ['refs/heads/main'],
				protectedEnvironments: ['production'],
				allowedWorkflowFiles: ['.github/workflows/unsafe-local-action.yml'],
				allowUntrustedCheckout: true,
				allowLocalActions: true,
				artifactPolicy: 'allowlisted',
				cachePolicy: 'allowlisted',
			},
		}).catch((error: unknown) => error);
		expect(await store.getWorkflowOperationRecord('unsafe-local-action-op')).toBeNull();
		await expect(enclave.dispatchWorkflowOperation({
			teamId: 'team-1',
			projectId: 'project-1',
			installationId: '99',
			operationId: 'unsafe-local-action-op',
			ref: 'refs/heads/main',
			environment: 'production',
			inputs: {},
		})).rejects.toMatchObject({ code: 'workflow_dispatch_blocked' });
	});
});
