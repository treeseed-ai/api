import { describe, expect, it, vi } from 'vitest';
import type { CapacityGovernanceDatabase } from '../../../../../src/api/capacity/database.ts';
import { resolveProviderSynthesisContext } from '../../../../../src/api/capacity/services/capacity/providers/provider-synthesis-context-service.ts';

const principal = { membershipId: 'membership-a', teamId: 'team-a', capacityProviderId: 'provider-a' };

function database(first: (query: string, params?: unknown[]) => Promise<Record<string, unknown> | null>): CapacityGovernanceDatabase {
	return {
		async ensureInitialized() {},
		first,
	} as unknown as CapacityGovernanceDatabase;
}

describe('provider synthesis context', () => {
	it('requires one exact active membership-scoped availability session', async () => {
		const first = vi.fn(async (query: string) => {
			if (query.includes('capacity_provider_team_memberships')) return { provider_id: 'provider-a', provider_status: 'active' };
			return {
				id: 'session-a', membership_id: 'membership-a', team_id: 'team-a', capacity_provider_id: 'provider-a',
				environment: 'local', status: 'open', available_from: '2026-07-17T11:00:00.000Z',
				available_until: '2026-07-17T13:00:00.000Z', expires_at: '2026-07-17T13:00:00.000Z', closed_at: null,
				execution_providers_json: '[{"id":"codex","status":"available","capabilities":["engineering"]}]',
			};
		});
		await expect(resolveProviderSynthesisContext(database(first), principal, {
			sessionId: 'session-a', environment: 'local', now: '2026-07-17T12:00:00.000Z',
		})).resolves.toMatchObject({
			provider: { id: 'provider-a', status: 'active' },
			session: { id: 'session-a', membershipId: 'membership-a', environment: 'local', status: 'open' },
			executionProviders: [{ id: 'codex', status: 'available', capabilities: ['engineering'] }],
			environment: 'local',
		});
		expect(first).toHaveBeenCalledTimes(2);
	});

	it('does not replace an unknown explicit session with a different open session', async () => {
		const first = vi.fn()
			.mockResolvedValueOnce({ provider_id: 'provider-a', provider_status: 'active' })
			.mockResolvedValueOnce(null);
		await expect(resolveProviderSynthesisContext(database(first), principal, {
			sessionId: 'unknown-session', now: '2026-07-17T12:00:00.000Z',
		})).rejects.toMatchObject({ code: 'provider_synthesis_session_not_found', status: 404 });
		expect(first).toHaveBeenCalledTimes(2);
	});

	it('propagates storage failure instead of synthesizing under incomplete authority', async () => {
		const failure = new Error('membership storage unavailable');
		await expect(resolveProviderSynthesisContext(database(async () => { throw failure; }), principal))
			.rejects.toBe(failure);
	});

	it('rejects expired and cross-environment sessions', async () => {
		const rows = (environment: string, availableUntil: string) => database(async (query) =>
			query.includes('capacity_provider_team_memberships')
				? { provider_id: 'provider-a', provider_status: 'active' }
				: {
					id: 'session-a', membership_id: 'membership-a', team_id: 'team-a', capacity_provider_id: 'provider-a',
					environment, status: 'open', available_from: '2026-07-17T11:00:00.000Z', available_until: availableUntil,
					execution_providers_json: '[]',
				},
		);
		await expect(resolveProviderSynthesisContext(rows('local', '2026-07-17T11:59:00.000Z'), principal, {
			now: '2026-07-17T12:00:00.000Z',
		})).rejects.toMatchObject({ code: 'provider_synthesis_window_expired' });
		await expect(resolveProviderSynthesisContext(rows('staging', '2026-07-17T13:00:00.000Z'), principal, {
			environment: 'local', now: '2026-07-17T12:00:00.000Z',
		})).rejects.toMatchObject({ code: 'provider_synthesis_environment_mismatch' });
	});
});
