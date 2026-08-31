import { describe, expect, it, vi } from 'vitest';
import { revealReusableRegistrationCode } from '../../../../src/api/control-plane/repositories/providers/provider-runtime-service.ts';

describe('team provider registration code', () => {
	it('reveals the current generation without declaring one-time consumption', async () => {
		const revealRegistrationKey = vi.fn().mockResolvedValue({
			teamId: 'team-1', generation: 7, keyPrefix: 'trsd_reg', registrationKey: 'team-registration-code',
		});
		const result = await revealReusableRegistrationCode({ revealRegistrationKey } as any, 'team-1', 'owner-1');
		expect(revealRegistrationKey).toHaveBeenCalledWith('team-1', 'owner-1');
		expect(result).toEqual({ teamId: 'team-1', connectionState: 'registration_ready', expiresAfterUse: false,
			registrationCode: 'team-registration-code', codePrefix: 'trsd_reg', generation: 7 });
		expect(result).not.toHaveProperty('enrollmentToken');
	});
});
