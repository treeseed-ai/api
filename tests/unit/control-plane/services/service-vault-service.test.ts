import { describe, expect, it, vi } from 'vitest';
import { createServiceVaultService } from '../../../../src/api/control-plane/repositories/services/service-vault-service.ts';

function fixture(fields: string[]) {
	let leaseRow: Record<string, unknown> | undefined;
	const store = {
		getTeamServiceConnection: vi.fn(async () => ({ id: 'state-connection', providerId: 'cloudflare' })),
		createPlatformOperation: vi.fn(async () => ({ id: 'operation-1' })),
		first: vi.fn(async (query: string) => {
			if (query.includes('team_service_vaults')) return { active_key_version: 1, encryption_version: 'v1', created_at: '', updated_at: '' };
			if (query.includes('team_service_capability_bindings')) return { id: 'binding-1' };
			if (query.includes('team_service_credential_profiles')) return { id: 'profile-1' };
			if (query.includes('service_operation_leases')) return leaseRow;
			return null;
		}),
		all: vi.fn(async (query: string) => query.includes('team_service_vault_grants')
			? [{ id: 'grant-1', team_id: 'team-1', user_id: 'user-1', user_vault_key_id: 'key-1', public_key: 'key', wrapped_team_vault_key: 'wrapped', key_version: 1, status: 'active', created_at: '', updated_at: '' }]
			: fields.map((field_key) => ({ field_key }))),
		run: vi.fn(async (query: string, params: unknown[]) => {
			if (query.includes('INSERT INTO service_operation_leases')) leaseRow = {
				id: params[0], team_id: params[1], connection_id: params[2], capability_type: params[3], purpose: params[4],
				resource_scope_json: params[5], credential_profile_id: params[6], actor_user_id: params[7], required_fields_json: params[8],
				status: 'awaiting-runner', expires_at: params[9], operation_correlation_id: params[10], hosted_binding_json: params[11],
				authority_requests_json: params[12], created_at: params[13], updated_at: params[14],
			};
			return { success: true };
		}),
	};
	return { service: createServiceVaultService(store), store };
}

describe('service vault operation leases', () => {
	it('includes a configured optional session token in the exact lease field set', async () => {
		const { service } = fixture(['accessKeyId', 'secretAccessKey', 'sessionToken']);
		const result = await service.createLease({ id: 'user-1', roles: ['admin'] }, 'team-1', {
			connectionId: 'state-connection', credentialProfileId: 's3-state-session', capabilityType: 'object-storage',
			purpose: 'provider-connection-validation',
		});
		expect(result.requiredFields).toEqual(['accessKeyId', 'secretAccessKey', 'sessionToken']);
	});

	it('permits an omitted optional session token but rejects a missing required state credential', async () => {
		const { service } = fixture(['accessKeyId', 'secretAccessKey']);
		const request = { connectionId: 'state-connection', credentialProfileId: 's3-state-session',
			capabilityType: 'object-storage', purpose: 'provider-connection-validation' };
		await expect(service.createLease({ id: 'user-1', roles: ['admin'] }, 'team-1', request))
			.resolves.toMatchObject({ requiredFields: ['accessKeyId', 'secretAccessKey'] });
		const incomplete = fixture(['accessKeyId']);
		await expect(incomplete.service.createLease({ id: 'user-1', roles: ['admin'] }, 'team-1', request))
			.rejects.toThrow(/required credential field/u);
	});
});
