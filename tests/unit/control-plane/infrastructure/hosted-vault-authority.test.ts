import { describe, expect, it, vi } from 'vitest';
import type { HostedInfrastructureAuthorityRequest } from '@treeseed/deployment/infrastructure/opentofu';
import { resolveHostedVaultMaterial } from '../../../../src/operations-runner/infrastructure/hosted-provider-authority.ts';

const request = (purpose: HostedInfrastructureAuthorityRequest['purpose']): HostedInfrastructureAuthorityRequest => ({ requestId: `${purpose}:digest`, teamId: 'team-1', deploymentId: 'treeseed-cloud', stackId: 'control-plane', environment: 'production', backendBindingDigest: `sha256:${'a'.repeat(64)}`, provider: purpose === 'provider' ? 'railway' : 'treeseed', connectionRef: purpose === 'provider' ? 'railway-production' : 'cloudflare-state', ...(purpose === 'state-encryption' ? { secretRef: 'state-key-ref' } : {}), credentialProfileId: purpose === 'provider' ? 'railway-workspace' : purpose === 'state-backend' ? 's3-state-session' : 'opentofu-state-encryption', capabilities: [purpose === 'provider' ? 'backend-hosting' : purpose === 'state-backend' ? 'object-storage' : 'state-encryption'], purpose });

describe('hosted service-vault authority', () => {
	it('resolves provider authority without returning its value through a connection record', async () => {
		const store = { first: vi.fn(async () => ({ id: 'authority-1', version: 3, scheme: 'environment-reference', reference: 'TREESEED_RAILWAY_TOKEN', capabilities_json: '["backend-hosting"]' })) };
		const material = await resolveHostedVaultMaterial({ store, request: request('provider'), env: { TREESEED_RAILWAY_TOKEN: 'runtime-only' } });
		expect(material).toMatchObject({ source: 'treeseed-service-credential-vault', teamId: 'team-1', authorityVersion: 3, values: { apiToken: 'runtime-only' } });
		expect(store.first.mock.calls[0]![1]).toEqual(['backend-hosting', 'team-1', 'railway-production', 'railway', 'railway-workspace']);
	});

	it('derives state sessions and encryption material only from the team storage authority', async () => {
		const store = { first: vi.fn(async () => ({ id: 'state-authority', version: 7, scheme: 'external-vault', reference: 'vault/team-1/state', capabilities_json: '["object-storage","state-encryption"]' })) };
		const externalResolver = vi.fn(async ({ request: value }: any) => ({ expiresAt: new Date(Date.now() + 30 * 60 * 1_000).toISOString(), values: value.purpose === 'state-backend' ? { accessKeyId: 'temporary-id', secretAccessKey: 'temporary-secret', sessionToken: 'temporary-session' } : { key: 'b'.repeat(64) } }));
		for (const purpose of ['state-backend', 'state-encryption'] as const) {
			const material = await resolveHostedVaultMaterial({ store, request: request(purpose), externalResolver });
			expect(material).toMatchObject({ teamId: 'team-1', deploymentId: 'treeseed-cloud', purpose, authorityId: 'state-authority' });
		}
		expect(store.first.mock.calls.every((call) => call[1][1] === 'team-1' && call[1][2] === 'cloudflare-state' && call[1][3] === 'cloudflare' && call[1][4] === 'cloudflare-storage')).toBe(true);
		expect((externalResolver.mock.calls[1]![0] as any).request.secretRef).toBe('state-key-ref');
	});
});
