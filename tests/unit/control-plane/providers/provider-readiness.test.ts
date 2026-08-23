import { describe, expect, it } from 'vitest';
import { providerAvailabilityIsRunnable } from '../../../../src/api/control-plane/repositories/providers/provider-runtime-service.ts';

describe('provider readiness', () => {
	it('requires both a fresh session and an active execution provider', () => {
		const sessions = [{ status: 'open', expires_at: '2026-08-23T09:00:00.000Z' }];
		const now = Date.parse('2026-08-23T08:00:00.000Z');
		expect(providerAvailabilityIsRunnable(sessions, 0, now)).toBe(false);
		expect(providerAvailabilityIsRunnable(sessions, 1, now)).toBe(true);
		expect(providerAvailabilityIsRunnable([{ ...sessions[0], expires_at: '2026-08-23T07:00:00.000Z' }], 1, now)).toBe(false);
	});
});
