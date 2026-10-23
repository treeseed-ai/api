import { describe, expect, it, vi } from 'vitest';
import { CapacityGovernanceError } from '../../../../../src/api/capacity/database.ts';
import { refreshProviderAvailability } from '../../../../../src/api/control-plane/repositories/providers/provider-runtime-service.ts';

const principal = { membershipId: 'membership-owned', teamId: 'team-owned', capacityProviderId: 'provider-owned', scopes: ['provider:availability:write'] };
const currentSession = { id: 'session-owned', status: 'open' as const, sequence: 2 };

function availability(refreshResult: unknown, conflictResult: unknown) {
	return {
		refresh: vi.fn().mockResolvedValue(refreshResult),
		refreshConflict: vi.fn().mockResolvedValue(conflictResult),
	};
}

describe('provider availability refresh conflict boundary', () => {
	it('adds only the authenticated owner current session identity to the existing 409', async () => {
		const service = availability(null, currentSession);
		const error = await refreshProviderAvailability(service as Parameters<typeof refreshProviderAvailability>[0], { principal }, currentSession.id, { expectedSequence: 1 }).catch(value => value);
		expect(error).toBeInstanceOf(CapacityGovernanceError);
		expect(error).toMatchObject({ code: 'provider_availability_refresh_conflict', status: 409, details: { currentSession } });
		expect(Object.keys(error.details.currentSession).sort()).toEqual(['id', 'sequence', 'status']);
		expect(service.refreshConflict).toHaveBeenCalledWith(principal, currentSession.id, 1);
	});

	it('keeps missing, closed, expired, and foreign sessions on the details-free 409 path', async () => {
		const service = availability(null, null);
		const error = await refreshProviderAvailability(service as Parameters<typeof refreshProviderAvailability>[0], { principal }, 'session-unknown', { expectedSequence: 4 }).catch(value => value);
		expect(error).toMatchObject({ code: 'provider_availability_refresh_conflict', status: 409, details: undefined });
	});

	it('does not query recovery details when refresh succeeds or provider scope is absent', async () => {
		const refreshed = { id: currentSession.id, status: 'open', sequence: 2 };
		const service = availability(refreshed, currentSession);
		await expect(refreshProviderAvailability(service as Parameters<typeof refreshProviderAvailability>[0], { principal }, currentSession.id, { expectedSequence: 1 })).resolves.toEqual(refreshed);
		expect(service.refreshConflict).not.toHaveBeenCalled();
		await expect(refreshProviderAvailability(service as Parameters<typeof refreshProviderAvailability>[0], { principal: { ...principal, scopes: [] } }, currentSession.id, { expectedSequence: 1 }))
			.rejects.toMatchObject({ code: 'provider_scope_required', status: 403 });
	});
});
