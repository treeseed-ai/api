import { describe, expect, it, vi } from 'vitest';
import { prepareTreeDxCredentialDelivery } from '../../../src/api/routes/treedx/repositories/treedx-credential-delivery-preparation.ts';
import { createRemoteGitCredentialDelivery } from '../../../src/security/remote-git-credential-delivery.ts';

describe('TreeDX credential delivery preparation', () => {
	it('reuses an unexpired delivery and creates a fresh attempt after consumption', async () => {
		const base = {
			operationId: 'operation-1', actorId: 'platform-runner', teamId: 'team-1', projectId: 'project-1',
			repositoryBindingId: 'binding-1', credentialAuthorityId: 'authority-1', nodeId: 'node-1',
			sourceRef: 'refs/heads/staging', destinationRef: 'refs/heads/staging', reviewedCommit: 'a'.repeat(40),
			expectedRemoteHead: 'a'.repeat(40), purpose: 'fetch' as const,
		};
		const reusableStore = {
			all: vi.fn().mockResolvedValue([{ delivery_id: 'delivery-ready', status: 'ready', expires_at: '2999-01-01T00:00:00.000Z' }]),
			run: vi.fn(), first: vi.fn(),
		};
		await expect(createRemoteGitCredentialDelivery({ store: reusableStore, ...base })).resolves.toMatchObject({
			deliveryId: 'delivery-ready', reused: true,
		});
		expect(reusableStore.run).not.toHaveBeenCalled();

		let recoveryDeliveryId = '';
		const recoveryStore = {
			all: vi.fn().mockResolvedValue([{ delivery_id: 'delivery-consumed', status: 'consumed', expires_at: '2999-01-01T00:00:00.000Z' }]),
			run: vi.fn().mockImplementation(async (sql: string, values: unknown[]) => {
				if (sql.includes('INSERT INTO remote_credential_deliveries')) recoveryDeliveryId = String(values[0]);
				return {};
			}),
			first: vi.fn().mockImplementation(async (sql: string) => sql.includes('remote_credential_deliveries')
				? { id: recoveryDeliveryId, expires_at: '2999-01-01T00:00:00.000Z' }
				: { id: 'grant-recovery' }),
		};
		await expect(createRemoteGitCredentialDelivery({ store: recoveryStore, ...base })).resolves.toMatchObject({ reused: false });
		expect(recoveryStore.run).toHaveBeenCalledTimes(2);

		let partialDeliveryId = '';
		const partialStore = {
			all: vi.fn().mockResolvedValue([{ id: 'grant-partial', delivery_id: null, grant_expires_at: '2999-01-01T00:00:00.000Z' }]),
			run: vi.fn().mockImplementation(async (sql: string, values: unknown[]) => {
				if (sql.includes('INSERT INTO remote_credential_deliveries')) partialDeliveryId = String(values[0]);
				return {};
			}),
			first: vi.fn().mockImplementation(async (sql: string) => sql.includes('remote_credential_deliveries')
				? { id: partialDeliveryId, expires_at: '2999-01-01T00:00:00.000Z' }
				: { id: 'grant-partial' }),
		};
		const recoveredPartial = await createRemoteGitCredentialDelivery({ store: partialStore, ...base });
		expect(recoveredPartial).toMatchObject({ reused: false });
		expect(recoveredPartial.deliveryId).toBe(partialDeliveryId);
		expect(partialStore.run).toHaveBeenCalledTimes(1);
	});

	it('reconciles first-party authority to the central token and returns only an opaque delivery id', async () => {
		const sha = 'a'.repeat(40);
		const runs: Array<{ sql: string; values: unknown[] }> = [];
		const store = {
			first: vi.fn().mockImplementation(async (sql: string) => {
				if (sql.includes('FROM projects p JOIN teams')) return { id: 'project-1', team_id: 'team-1', slug: 'market-api' };
				if (sql.includes('FROM team_service_connections')) return {
					connection_id: 'connection-1', capability_binding_id: 'capability-1',
					credential_profile_id: 'github-repository-token', authority_id: 'authority-1',
					authority_reference: 'TREESEED_GITHUB_TOKEN_KNOWLEDGE_COOP_MARKET',
				};
				if (sql.includes('FROM provider_credential_authorities a')) return {
					id: 'authority-1', team_id: 'team-1', connection_id: 'connection-1',
					credential_profile_id: 'github-repository-token', scheme: 'environment-reference',
					reference: 'TREESEED_GITHUB_TOKEN', capabilities_json: '["repository-hosting"]',
					status: 'ready', non_secret_config_json: '{}', owner: 'treeseed-ai', name: 'market-api-content',
				};
				if (sql.includes('project_remote_repository_bindings WHERE project_id')) return null;
				if (sql.includes('remote_git_operation_grants WHERE idempotency_key')) return { id: 'grant-1' };
				if (sql.includes('remote_credential_deliveries WHERE grant_id')) {
					const insertion = runs.findLast((entry) => entry.sql.includes('INSERT INTO remote_credential_deliveries'));
					return { id: insertion?.values[0], expires_at: '2999-01-01T00:00:00.000Z' };
				}
				return null;
			}),
			all: vi.fn().mockResolvedValue([]),
			run: vi.fn().mockImplementation(async (sql: string, values: unknown[]) => { runs.push({ sql, values }); return {}; }),
			recordAuditEvent: vi.fn().mockResolvedValue(undefined),
		};
		const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
			const payload = url.includes('/git/ref/heads/')
				? { object: { sha } }
				: { id: 42, name: 'market-api-content', owner: { login: 'treeseed-ai' }, archived: false, disabled: false };
			return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
		});

		const result = await prepareTreeDxCredentialDelivery({
			store,
			env: { TREESEED_GITHUB_TOKEN: 'central-secret' },
			fetchImpl: fetchImpl as typeof fetch,
			body: {
				teamSlug: 'treeseed', projectSlug: 'market-api', owner: 'treeseed-ai', name: 'market-api-content',
				nodeId: 'node-local', sourceRef: 'refs/heads/staging', destinationRef: 'refs/heads/staging',
				expectedRemoteHead: sha, refspec: '+refs/heads/staging:refs/heads/staging', idempotencyKey: 'sync-1',
			},
		});

		expect(result).toMatchObject({ deliveryId: expect.any(String), reused: false });
		expect(result.deliveryId).toEqual(expect.any(String));
		expect(JSON.stringify(result)).not.toContain('central-secret');
		expect(runs.some((entry) => entry.sql.includes("reference = 'TREESEED_GITHUB_TOKEN'"))).toBe(true);
		expect(runs.some((entry) => entry.sql.includes('INSERT INTO project_remote_repository_bindings'))).toBe(true);
		expect(runs.some((entry) => entry.sql.includes('INSERT INTO remote_credential_deliveries'))).toBe(true);
		expect(store.recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
			eventType: 'treedx.credential_delivery.prepared', actorId: 'platform-runner',
		}));
	});
});
