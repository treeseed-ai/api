import { describe, expect, it, vi } from 'vitest';
import { registrationCodeReceipt, registrationCodeStatus, revealReusableRegistrationCode } from '../../../../src/api/control-plane/repositories/providers/provider-runtime-service.ts';

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

	it('publishes value-safe status and credential receipts', () => {
		const metadata = { teamId: 'team-1', generation: 7, keyPrefix: 'trsd_reg', createdAt: '2026-09-01T20:00:00.000Z', rotatedAt: null };
		expect(registrationCodeStatus(metadata)).toEqual({ schemaVersion: 'treeseed.provider-registration-code-status/v1', teamId: 'team-1', generation: 7,
			codePrefix: 'trsd_reg', rotatedAt: metadata.createdAt });
		expect(registrationCodeReceipt({ ...metadata, registrationKey: 'registration-code-secret' })).toEqual({ schemaVersion: 'treeseed.provider-registration-code-receipt/v1',
			teamId: 'team-1', generation: 7, codePrefix: 'trsd_reg', registrationCode: 'registration-code-secret', rotatedAt: metadata.createdAt });
	});
});
