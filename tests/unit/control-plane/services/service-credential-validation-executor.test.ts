import { describe, expect, it, vi } from 'vitest';
import { sealSecretOperationPayload } from '@treeseed/sdk/secrets-capability';
import { createServiceCredentialValidationExecutor } from '../../../../src/operations-runner/security/service-credential-validation-executor.ts';

function fixture() {
	const row: any = {
		id: 'lease-1', team_id: 'team-1', connection_id: 'connection-1', purpose: 'provider-connection-validation',
		status: 'awaiting-runner', expires_at: new Date(Date.now() + 60_000).toISOString(),
		required_fields_json: JSON.stringify(['apiToken']), credential_profile_id: 'cloudflare-runtime',
	};
	const store = {
		first: vi.fn(async (query: string) => query.includes('service_operation_leases') ? row : null),
		run: vi.fn(async (query: string, params: any[]) => {
			if (query.includes("status='pending'")) { row.public_key = params[0]; row.status = 'pending'; }
			if (query.includes("status='consumed'")) { row.sealed_payload = null; row.status = 'consumed'; row.consumed_at = params[0]; }
			if (query.includes("status='failed'")) { row.sealed_payload = null; row.status = 'failed'; }
			return { success: true, meta: { changes: 1 } };
		}),
		getTeamServiceConnection: vi.fn(async () => ({ id: 'connection-1', providerId: 'cloudflare', nonSecretConfig: {} })),
	};
	return { row, store };
}

describe('service credential validation executor', () => {
	it('opens one exact payload, validates it, and destroys persisted ciphertext', async () => {
		const { row, store } = fixture();
		const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
		const executor = createServiceCredentialValidationExecutor({ controlPlaneStore: store, fetchImpl });
		const result = await executor.run({ teamId: 'team-1', leaseId: 'lease-1' }, {
			throwIfCancelled: vi.fn(),
			checkpoint: vi.fn(async () => {
				row.sealed_payload = await sealSecretOperationPayload({ apiToken: 'provider-secret' }, row.public_key);
				row.status = 'ready';
			}),
		});
		expect(result).toMatchObject({ ok: true, leaseId: 'lease-1' });
		expect(row).toMatchObject({ status: 'consumed', sealed_payload: null });
		expect(fetchImpl).toHaveBeenCalledWith('https://api.cloudflare.com/client/v4/user/tokens/verify', expect.objectContaining({
			headers: { authorization: 'Bearer provider-secret' },
		}));
	});

	it('fails closed when the payload grants an extra field', async () => {
		const { row, store } = fixture();
		const executor = createServiceCredentialValidationExecutor({ controlPlaneStore: store, fetchImpl: vi.fn() as any });
		await expect(executor.run({ teamId: 'team-1', leaseId: 'lease-1' }, {
			throwIfCancelled: vi.fn(),
			checkpoint: vi.fn(async () => {
				row.sealed_payload = await sealSecretOperationPayload({ apiToken: 'provider-secret', extra: 'forbidden' }, row.public_key);
				row.status = 'ready';
			}),
		})).rejects.toThrow(/exact required fields/u);
		expect(row).toMatchObject({ status: 'failed', sealed_payload: null });
	});
});

