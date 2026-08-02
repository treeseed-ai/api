import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGitHubConfigurationExecutor } from '../../../../src/operations-runner/workflows/github-configuration-executor.ts';
import { clearWorkflowConfigurationDeliveries, registerWorkflowConfigurationDelivery } from '../../../../src/operations-runner/workflows/configuration-deliveries.ts';

describe('GitHub workflow configuration executor', () => {
	beforeEach(() => clearWorkflowConfigurationDeliveries());

	it('forwards GitHub-encrypted secret material once without durable payload storage', async () => {
		vi.stubEnv('TREESEED_GITHUB_TOKEN_EXAMPLE_REPO', 'provider-token');
		const encrypted = 'R2l0SHViRW5jcnlwdGVkVmFsdWU=';
		const payloadDigest = createHash('sha256').update(encrypted).digest('hex');
		const delivery = { id: 'delivery-a', operation_id: 'operation-a', record_id: 'record-a', action: 'upsert',
			payload_digest: payloadDigest, key_id: 'key-a', status: 'ready', expires_at: '2099-01-01T00:00:00Z' };
		registerWorkflowConfigurationDelivery({ id: delivery.id, operationId: delivery.operation_id, payload: encrypted,
			payloadDigest, keyId: delivery.key_id, expiresAt: new Date(Date.now() + 60_000).toISOString() });
		delivery.expires_at = new Date(Date.now() + 60_000).toISOString();
		const record = { id: 'record-a', project_id: 'project-a', team_id: 'team-a', workflow_binding_id: 'binding-a',
			repository_binding_id: 'repository-a', kind: 'secret', scope: 'repository', environment: null, name: 'DEPLOY_TOKEN' };
		const repository = { id: 'repository-a', project_id: 'project-a', team_id: 'team-a', service_connection_id: 'connection-a',
			provider_id: 'github', provider_repository_id: '77', owner: 'example', name: 'repo', authority_id: 'authority-a' };
		const capability = { id: 'binding-a', connection_id: 'connection-a', credential_profile_id: 'github-workflow-token',
			capability_type: 'secret-enclave' };
		const authority = { id: 'authority-a', team_id: 'team-a', connection_id: 'connection-a',
			credential_profile_id: 'github-workflow-token', scheme: 'environment-reference',
			reference: 'TREESEED_GITHUB_TOKEN_EXAMPLE_REPO', capabilities_json: '["secret-enclave"]', status: 'ready' };
		const store = {
			first: vi.fn(async (sql: string) => {
				if (sql.includes('workflow_configuration_deliveries')) return delivery;
				if (sql.includes('workflow_configuration_records')) return record;
				if (sql.includes('project_remote_repository_bindings') && !sql.includes('JOIN')) return repository;
				if (sql.includes('team_service_capability_bindings')) return capability;
				if (sql.includes('provider_credential_authorities') && sql.includes('JOIN')) return { ...authority, ...repository,
					non_secret_config_json: '{}', authority_id: authority.id };
				if (sql.includes('provider_credential_authorities')) return authority;
				return null;
			}),
			run: vi.fn(async () => undefined), recordAuditEvent: vi.fn(async () => undefined),
		};
		const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
		const executor = createGitHubConfigurationExecutor({ controlPlaneStore: store, fetchImpl: fetchImpl as typeof fetch });
		const result = await executor.run({ deliveryId: delivery.id }, { operation: { id: 'operation-a', assignedRunnerId: 'runner-a' } });
		expect(result).toMatchObject({ recordId: record.id, status: 'configured', digest: payloadDigest });
		expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ encrypted_value: encrypted, key_id: 'key-a' });
		const cleanup = store.run.mock.calls.find(([sql]) => String(sql).includes("status = 'consumed'"));
		expect(cleanup).toBeTruthy();
		expect(JSON.stringify(store.run.mock.calls)).not.toContain(encrypted);
		expect(JSON.stringify(store.recordAuditEvent.mock.calls)).not.toContain(encrypted);
	});

	it('fails closed and destroys the delivery payload after provider rejection', async () => {
		vi.stubEnv('TREESEED_GITHUB_TOKEN_EXAMPLE_REPO', 'provider-token');
		const rows: Record<string, any> = {
			delivery: { id: 'delivery-a', operation_id: 'operation-a', record_id: 'record-a', action: 'delete', payload_digest: null,
				key_id: null, status: 'ready', expires_at: new Date(Date.now() + 60_000).toISOString() },
			record: { id: 'record-a', project_id: 'project-a', team_id: 'team-a', workflow_binding_id: 'binding-a',
				repository_binding_id: 'repository-a', kind: 'variable', scope: 'repository', name: 'REGION' },
			repository: { id: 'repository-a', project_id: 'project-a', team_id: 'team-a', service_connection_id: 'connection-a',
				provider_id: 'github', owner: 'example', name: 'repo', authority_id: 'authority-a' },
			capability: { id: 'binding-a', connection_id: 'connection-a', credential_profile_id: 'github-workflow-token', capability_type: 'workflow-configuration' },
			authority: { id: 'authority-a', team_id: 'team-a', connection_id: 'connection-a', credential_profile_id: 'github-workflow-token',
				scheme: 'environment-reference', reference: 'TREESEED_GITHUB_TOKEN_EXAMPLE_REPO', capabilities_json: '["workflow-configuration"]', status: 'ready' },
		};
		registerWorkflowConfigurationDelivery({ id: 'delivery-a', operationId: 'operation-a', payload: null,
			payloadDigest: null, keyId: null, expiresAt: rows.delivery.expires_at });
		const store = { first: vi.fn(async (sql: string) => sql.includes('workflow_configuration_deliveries') ? rows.delivery
			: sql.includes('workflow_configuration_records') ? rows.record
			: sql.includes('project_remote_repository_bindings') && !sql.includes('JOIN') ? rows.repository
			: sql.includes('team_service_capability_bindings') ? rows.capability
			: sql.includes('JOIN') ? { ...rows.authority, ...rows.repository, non_secret_config_json: '{}' } : rows.authority),
			run: vi.fn(async () => undefined), recordAuditEvent: vi.fn() };
		const executor = createGitHubConfigurationExecutor({ controlPlaneStore: store,
			fetchImpl: vi.fn(async () => new Response('', { status: 403 })) as typeof fetch });
		await expect(executor.run({ deliveryId: 'delivery-a' }, { operation: { id: 'operation-a' } })).rejects.toThrow(/HTTP 403/u);
		expect(store.run.mock.calls.some(([sql]) => String(sql).includes("status = 'failed'"))).toBe(true);
	});

	it('limits an organization secret to the bound repository', async () => {
		vi.stubEnv('TREESEED_GITHUB_TOKEN_EXAMPLE_REPO', 'provider-token');
		const encrypted = 'R2l0SHViRW5jcnlwdGVkVmFsdWU=';
		const payloadDigest = createHash('sha256').update(encrypted).digest('hex');
		const rows: Record<string, any> = {
			delivery: { id: 'delivery-org', operation_id: 'operation-org', record_id: 'record-org', action: 'upsert',
				payload_digest: payloadDigest, key_id: 'key-org', status: 'ready', expires_at: new Date(Date.now() + 60_000).toISOString() },
			record: { id: 'record-org', project_id: 'project-a', team_id: 'team-a', workflow_binding_id: 'binding-a',
				repository_binding_id: 'repository-a', kind: 'secret', scope: 'organization', name: 'DEPLOY_TOKEN' },
			repository: { id: 'repository-a', project_id: 'project-a', team_id: 'team-a', service_connection_id: 'connection-a',
				provider_id: 'github', provider_repository_id: '77', owner: 'example', name: 'repo', authority_id: 'authority-a' },
			capability: { id: 'binding-a', connection_id: 'connection-a', credential_profile_id: 'github-workflow-token', capability_type: 'secret-enclave' },
			authority: { id: 'authority-a', team_id: 'team-a', connection_id: 'connection-a', credential_profile_id: 'github-workflow-token',
				scheme: 'environment-reference', reference: 'TREESEED_GITHUB_TOKEN_EXAMPLE_REPO', capabilities_json: '["secret-enclave"]', status: 'ready' },
		};
		registerWorkflowConfigurationDelivery({ id: rows.delivery.id, operationId: rows.delivery.operation_id, payload: encrypted,
			payloadDigest, keyId: rows.delivery.key_id, expiresAt: rows.delivery.expires_at });
		const store = { first: vi.fn(async (sql: string) => sql.includes('workflow_configuration_deliveries') ? rows.delivery
			: sql.includes('workflow_configuration_records') ? rows.record
			: sql.includes('project_remote_repository_bindings') && !sql.includes('JOIN') ? rows.repository
			: sql.includes('team_service_capability_bindings') ? rows.capability
			: sql.includes('JOIN') ? { ...rows.authority, ...rows.repository, non_secret_config_json: '{}' } : rows.authority),
			run: vi.fn(async () => undefined), recordAuditEvent: vi.fn() };
		const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
		const executor = createGitHubConfigurationExecutor({ controlPlaneStore: store, fetchImpl: fetchImpl as typeof fetch });
		await executor.run({ deliveryId: rows.delivery.id }, { operation: { id: rows.delivery.operation_id } });
		expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ encrypted_value: encrypted,
			key_id: 'key-org', visibility: 'selected', selected_repository_ids: [77] });
	});
});
