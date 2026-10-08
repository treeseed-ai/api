import { describe, expect, it, vi } from 'vitest';
import { createAssignmentService } from '../../../../../../../src/api/control-plane/repositories/capacity/assignment-service.ts';

describe('authorized unresolved usage recovery', () => {
	it('requires team management before unresolved recovery and derives actor and operation identity only from authenticated context', async () => {
		const recoverCapacityAssignment = vi.fn(async (_team, _id, input) => input);
		const store = { principalCanAccessTeam: vi.fn(async () => true),
			getTeamAccessSummary: vi.fn(async () => ({ permissions: ['teams:manage:team'] })), recoverCapacityAssignment };
		const service = createAssignmentService(store), body = { expectedStateVersion: 7, reason: 'Native clock unavailable' };
		const held = structuredClone(body);
		await expect(service.recover(undefined, 'team', 'expired', body, 'recovery')).rejects.toMatchObject({ status: 401 });
		store.principalCanAccessTeam.mockResolvedValueOnce(false);
		await expect(service.recover({ id: 'foreign' }, 'team', 'expired', body, 'recovery')).rejects.toMatchObject({ status: 403 });
		store.getTeamAccessSummary.mockResolvedValueOnce({ permissions: [] });
		await expect(service.recover({ id: 'reader' }, 'team', 'expired', body, 'recovery')).rejects.toMatchObject({ status: 403 });
		expect(recoverCapacityAssignment).not.toHaveBeenCalled();
		await expect(service.recover({ id: 'operator' }, 'team', 'expired', body, 'recovery'))
			.resolves.toEqual({ ...body, actorId: 'operator', idempotencyKey: 'recovery' });
		expect(recoverCapacityAssignment).toHaveBeenCalledTimes(1); expect(body).toEqual(held);
	});
	it('denies malformed version reason and every caller measurement or actor field before the owning recovery mutation', async () => {
		const recoverCapacityAssignment = vi.fn(), service = createAssignmentService({ recoverCapacityAssignment });
		const valid = { expectedStateVersion: 1, reason: 'Unresolved actual active clock' };
		const invalid = [null, {}, { ...valid, reason: '' }, { ...valid, reason: ' ' }, { ...valid, reason: 1 },
			...[undefined, null, '', '1', true, 0, -1, 0.5, NaN, Infinity].map(expectedStateVersion => ({ ...valid, expectedStateVersion })),
			...['actorId', 'activeSeconds', 'elapsedSeconds', 'usageActual', 'nativeUsage', 'usd', 'leaseToken', 'settled', 'usageStatus']
				.flatMap(field => [undefined, null, 0, 'supplied'].map(value => ({ ...valid, [field]: value })))];
		for (const body of invalid) {
			const held = structuredClone(body);
			await expect(service.recover({ id: 'admin', roles: ['admin'] }, 'team', 'expired', body, 'recovery'))
				.rejects.toMatchObject({ status: 400, code: 'capacity_recovery_input_invalid' });
			expect(body).toEqual(held);
		}
		expect(recoverCapacityAssignment).not.toHaveBeenCalled();
	});
});
