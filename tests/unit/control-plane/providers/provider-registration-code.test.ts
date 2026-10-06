import { describe, expect, it, vi } from 'vitest';
import { registrationCodeReceipt, registrationCodeStatus, revealReusableRegistrationCode } from '../../../../src/api/control-plane/repositories/providers/provider-runtime-service.ts';
import { CapacityGovernanceRepository } from '../../../../src/api/capacity/repositories/governance/policy/governance.ts';
import { CapacityRegistrationService } from '../../../../src/api/capacity/services/support/registration-service.ts';
import { CapacitySecretCodec } from '../../../../src/api/capacity/security.ts';
import type { CapacityGovernanceDatabase } from '../../../../src/api/capacity/database.ts';

describe('team provider registration code', () => {
	it('refuses missing committed registration key metadata before returning a status or reveal receipt or recording a false audit', async () => {
		const database: CapacityGovernanceDatabase = { ensureInitialized: async () => undefined,
			first: async () => { throw new Error('Unexpected independent read'); }, all: async () => { throw new Error('Unexpected inventory'); },
			run: async () => { throw new Error('Unexpected audit'); }, batch: async () => { throw new Error('Unexpected transaction'); } };
		const repository = new CapacityGovernanceRepository(database), codec = new CapacitySecretCodec('test-signing-secret-with-24-bytes', 'test-encryption-secret-with-24-bytes');
		const service = new CapacityRegistrationService(repository, codec, 'http://localhost');
		const metadata = { teamId: 'team-1', generation: 7, keyPrefix: 'trsd_reg', status: 'active' as const,
			createdAt: '2026-09-01T20:00:00.000Z', updatedAt: '2026-09-01T20:00:00.000Z', rotatedAt: null, lastRevealedAt: null };
		vi.spyOn(repository, 'teamExists').mockResolvedValue(true);
		const read = vi.spyOn(repository, 'registrationKeyMetadata');
		vi.spyOn(repository, 'createRegistrationKey').mockResolvedValue(null);
		vi.spyOn(repository, 'currentRegistrationKeyRow').mockResolvedValue({ generation: 7, key_prefix: metadata.keyPrefix,
			encrypted_reveal_value: codec.encrypt('controlled-unit-key', 'team-1:7') });
		const reveal = vi.spyOn(repository, 'recordRegistrationKeyReveal').mockResolvedValue();
		try {
			const errors: unknown[] = [];
			read.mockResolvedValue(null);
			try { await service.registrationKey('team-1', 'owner-1'); } catch (error) { errors.push(error); }
			expect(reveal).not.toHaveBeenCalled();
			read.mockReset(); read.mockResolvedValueOnce(metadata).mockResolvedValue(null);
			try { await service.revealRegistrationKey('team-1', 'owner-1'); } catch (error) { errors.push(error); }
			expect(reveal).toHaveBeenCalledExactlyOnceWith('team-1', expect.any(String));
			expect(errors).toMatchObject([{ status: 404, code: 'registration_key_missing' }, { status: 404, code: 'registration_key_missing' }]);
		} finally { vi.restoreAllMocks(); }
	});
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
		const { rotatedAt: _rotation, ...unrotated } = metadata;
		for (const input of [unrotated, metadata, { ...metadata, rotatedAt: '2026-09-02T20:00:00.000Z' }]) {
			const held = structuredClone(input), expected = 'rotatedAt' in input ? input.rotatedAt ?? metadata.createdAt : metadata.createdAt;
			expect(registrationCodeStatus(input)).toEqual({ schemaVersion: 'treeseed.provider-registration-code-status/v1',
				teamId: metadata.teamId, generation: metadata.generation, codePrefix: metadata.keyPrefix, rotatedAt: expected });
			expect(registrationCodeReceipt({ ...input, registrationKey: 'registration-code-secret' })).toEqual({
				schemaVersion: 'treeseed.provider-registration-code-receipt/v1', teamId: metadata.teamId, generation: metadata.generation,
				codePrefix: metadata.keyPrefix, registrationCode: 'registration-code-secret', rotatedAt: expected });
			expect(input).toEqual(held);
		}
	});
});
