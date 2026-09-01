import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { describe, expect, it, vi } from 'vitest';
import { createProviderRegistrationAndAvailabilityOperations } from '../../../../src/api/control-plane/catalog/providers/registration-and-availability.ts';

function service() {
	return {
		authenticator: {},
		list: vi.fn(), show: vi.fn(), status: vi.fn(), diagnose: vi.fn(), connect: vi.fn(), disconnect: vi.fn(),
		registrationCodeStatus: vi.fn(), revealRegistrationCode: vi.fn(), rotateRegistrationCode: vi.fn(),
		requests: vi.fn(), request: vi.fn(), approve: vi.fn(), reject: vi.fn(), credentials: vi.fn(), rotateCredentials: vi.fn(), revokeCredentials: vi.fn(),
		environmentProfiles: { list: vi.fn(), show: vi.fn(), publish: vi.fn(), showGrant: vi.fn(), putGrant: vi.fn(), revokeGrant: vi.fn() },
		register: vi.fn(), registration: vi.fn(), exchangeCredential: vi.fn(), issueAccessToken: vi.fn(),
		leave: vi.fn(), rotateIdentity: vi.fn(), rotateCredential: vi.fn(), createAvailability: vi.fn(),
		refreshAvailability: vi.fn(), closeAvailability: vi.fn(),
	} as any;
}

describe('provider registration and availability catalog', () => {
	it('binds the exact portable SDK operations without route metadata', () => {
		const operations = createProviderRegistrationAndAvailabilityOperations({ providers: service() });
		expect(operations.map((operation) => operation.binding)).toEqual([
			CONTROL_PLANE_OPERATIONS.providers.list,
			CONTROL_PLANE_OPERATIONS.providers.show,
			CONTROL_PLANE_OPERATIONS.providers.status,
			CONTROL_PLANE_OPERATIONS.providers.diagnose,
			CONTROL_PLANE_OPERATIONS.providers.connect,
			CONTROL_PLANE_OPERATIONS.providers.registrationCode.status,
			CONTROL_PLANE_OPERATIONS.providers.registrationCode.reveal,
			CONTROL_PLANE_OPERATIONS.providers.registrationCode.rotate,
			CONTROL_PLANE_OPERATIONS.providers.disconnect,
			CONTROL_PLANE_OPERATIONS.providers.requests.list,
			CONTROL_PLANE_OPERATIONS.providers.requests.show,
			CONTROL_PLANE_OPERATIONS.providers.requests.approve,
			CONTROL_PLANE_OPERATIONS.providers.requests.reject,
			CONTROL_PLANE_OPERATIONS.providers.credentials.status,
			CONTROL_PLANE_OPERATIONS.providers.credentials.rotate,
			CONTROL_PLANE_OPERATIONS.providers.credentials.revoke,
			CONTROL_PLANE_OPERATIONS.providers.environmentProfiles.list,
			CONTROL_PLANE_OPERATIONS.providers.environmentProfiles.show,
			CONTROL_PLANE_OPERATIONS.providers.environmentProfiles.publish,
			CONTROL_PLANE_OPERATIONS.providers.environmentGrants.show,
			CONTROL_PLANE_OPERATIONS.providers.environmentGrants.put,
			CONTROL_PLANE_OPERATIONS.providers.environmentGrants.revoke,
			CONTROL_PLANE_OPERATIONS.providers.register,
			CONTROL_PLANE_OPERATIONS.providers.registration,
			CONTROL_PLANE_OPERATIONS.providers.exchangeCredential,
			CONTROL_PLANE_OPERATIONS.providers.issueAccessToken,
			CONTROL_PLANE_OPERATIONS.providers.leaveMembership,
			CONTROL_PLANE_OPERATIONS.providers.rotateIdentity,
			CONTROL_PLANE_OPERATIONS.providers.rotateCredential,
			CONTROL_PLANE_OPERATIONS.providers.createAvailability,
			CONTROL_PLANE_OPERATIONS.providers.refreshAvailability,
			CONTROL_PLANE_OPERATIONS.providers.closeAvailability,
		]);
	});

	it('keeps credentials in the invocation context and passes provider identity explicitly', async () => {
		const providers = service();
		providers.issueAccessToken.mockResolvedValue({ token: 'redacted' });
		providers.createAvailability.mockResolvedValue({ id: 'session-1' });
		const operations = createProviderRegistrationAndAvailabilityOperations({ providers });
		const token = operations.find((operation) => operation.binding === CONTROL_PLANE_OPERATIONS.providers.issueAccessToken)!;
		await token.handler({ path: {}, query: {}, body: { credentialId: 'credential-1', proof: {} } }, {
			interface: 'rest', requestId: 'request-1', idempotencyKey: 'key-1', requestHeaders: { authorization: 'Treeseed-Credential secret' },
		});
		expect(providers.issueAccessToken).toHaveBeenCalledWith(expect.any(Object), { authorization: 'Treeseed-Credential secret' }, 'key-1');
		const availability = operations.find((operation) => operation.binding === CONTROL_PLANE_OPERATIONS.providers.createAvailability)!;
		await availability.handler({ path: {}, query: {}, body: { ttlSeconds: 30 } }, {
			interface: 'rest', requestId: 'request-2', providerAuth: { principal: { membershipId: 'membership-1' } },
		});
		expect(providers.createAvailability).toHaveBeenCalledWith({ principal: { membershipId: 'membership-1' } }, { ttlSeconds: 30 });
	});
});
