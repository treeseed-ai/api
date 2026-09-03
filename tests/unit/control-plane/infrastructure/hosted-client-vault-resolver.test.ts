import { describe, expect, it, vi } from 'vitest';
import { sealSecretOperationPayload, type HostedSecretOperationBinding } from '@treeseed/sdk/secrets-capability';
import type { HostedInfrastructureAuthorityRequest } from '@treeseed/deployment/infrastructure/opentofu';
import { withHostedClientVaultLeases } from '../../../../src/operations-runner/infrastructure/hosted-client-vault-resolver.ts';

const binding: HostedSecretOperationBinding = {
	subjectType: 'plan', subjectDigest: `sha256:${'a'.repeat(64)}`, deploymentId: 'treeseed-cloud',
	stackId: 'control-plane', environment: 'staging',
};
const request: HostedInfrastructureAuthorityRequest = {
	requestId: 'railway-staging:railway-workspace', teamId: 'team-1', deploymentId: 'treeseed-cloud',
	stackId: 'control-plane', environment: 'staging', backendBindingDigest: `sha256:${'b'.repeat(64)}`,
	provider: 'railway', connectionRef: 'railway-staging', credentialProfileId: 'railway-workspace',
	capabilities: ['backend-hosting'], purpose: 'provider',
};

function fixture(overrides: Record<string, unknown> = {}) {
	const row: any = {
		id: 'lease-1', team_id: 'team-1', connection_id: 'connection-1', credential_profile_id: 'railway-workspace',
		purpose: 'hosted-topology-apply', status: 'awaiting-runner', expires_at: new Date(Date.now() + 60_000).toISOString(),
		hosted_binding_json: JSON.stringify(binding), required_fields_json: JSON.stringify(['apiToken']),
		authority_requests_json: JSON.stringify([{ ...request, connectionId: 'connection-1' }]), ...overrides,
	};
	const authority = { id: 'authority-1', version: 3 };
	const store = {
		first: vi.fn(async (query: string, values: unknown[]) => {
			if (query.includes('service_operation_leases')) return values.length === 1 || values[1] === row.team_id ? row : null;
			if (query.includes('provider_credential_authorities')) return authority;
			return null;
		}),
		run: vi.fn(async (query: string, values: any[]) => {
			if (query.includes("status='pending'")) { row.public_key = values[0]; row.status = 'pending'; }
			if (query.includes("status='consumed'")) { row.sealed_payload = null; row.status = 'consumed'; row.consumed_at = values[0]; }
			if (query.includes("status='failed'")) { row.sealed_payload = null; row.status = 'failed'; }
			return { meta: { changes: 1 } };
		}),
	};
	return { row, store };
}

async function execute(input: ReturnType<typeof fixture>, values: Record<string, string> = { apiToken: 'railway-secret' }) {
	return withHostedClientVaultLeases({ store: input.store, teamId: 'team-1', leaseIds: ['lease-1'],
		purpose: 'hosted-topology-apply', binding, context: {
			throwIfCancelled: vi.fn(), checkpoint: vi.fn(async () => {
				input.row.sealed_payload = await sealSecretOperationPayload(values, input.row.public_key);
				input.row.status = 'ready';
			}),
		}, run: async (resolver) => resolver!(request) });
}

describe('hosted client-vault resolver', () => {
	it('opens exact team-bound material once and destroys persisted ciphertext', async () => {
		const value = fixture(), material = await execute(value);
		expect(material).toMatchObject({ authorityId: 'authority-1', authorityVersion: 3,
			values: { apiToken: 'railway-secret' } });
		expect(value.row).toMatchObject({ status: 'consumed', sealed_payload: null });
		await expect(execute(value)).rejects.toThrow(/missing, expired, already used, or has the wrong purpose/u);
	});

	it.each([
		['wrong purpose', { purpose: 'hosted-topology-plan' }],
		['expired', { expires_at: new Date(Date.now() - 1_000).toISOString() }],
		['wrong digest', { hosted_binding_json: JSON.stringify({ ...binding, subjectDigest: `sha256:${'c'.repeat(64)}` }) }],
	])('rejects %s before accepting ciphertext', async (_label, overrides) => {
		const value = fixture(overrides);
		await expect(execute(value)).rejects.toThrow();
		expect(value.row.status).not.toBe('consumed');
	});

	it('rejects cross-team lease access', async () => {
		const value = fixture({ team_id: 'team-2' });
		await expect(execute(value)).rejects.toThrow(/missing, expired, already used, or has the wrong purpose/u);
	});

	it('rejects and destroys a payload with additional fields', async () => {
		const value = fixture();
		await expect(execute(value, { apiToken: 'railway-secret', extra: 'forbidden' })).rejects.toThrow(/exact profile fields/u);
		expect(value.row).toMatchObject({ status: 'failed', sealed_payload: null });
	});
});
