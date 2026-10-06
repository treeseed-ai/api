import { beforeEach, describe, expect, it, vi } from 'vitest';
const accounting = vi.hoisted(() => ({ settle: vi.fn(), report: vi.fn() }));
vi.mock('../../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts', () => ({ settleCapacityReservationExactlyOnce: accounting.settle }));
vi.mock('../../../../../../src/api/capacity/services/capacity/accounting/usage-report-service.ts', () => ({ reportCapacityUsage: accounting.report }));
import { createProviderAssignmentService } from '../../../../../../src/api/control-plane/repositories/providers/provider-assignment-service.ts';
import { frozenAttempt, terminalUsage } from '../../../capacity/accounting/architecture/settlement-fixture.ts';
const auth = { principal: { teamId: 'team', membershipId: 'membership', capacityProviderId: 'provider',
	scopes: ['provider:usage:write', 'provider:assignments:write'] } };
function service() {
	const store = { first: vi.fn().mockResolvedValue({ id: frozenAttempt.id, team_id: 'team', membership_id: 'membership',
		reservation_id: 'reservation', capacity_provider_id: 'provider', attempt_count: 1, assignment_attempt_json: JSON.stringify(frozenAttempt) }) };
	return createProviderAssignmentService(store as never);
}
beforeEach(() => { accounting.settle.mockReset().mockResolvedValue({ replayed: false }); accounting.report.mockReset().mockResolvedValue({ replayed: false }); });
// UNIT request-boundary proof only; mocked accounting is not persistence or provider proof.
describe('provider accounting preserves measured and membership authority', () => {
	it('retains exact configured attempt and measured input without mutating the caller', async () => {
		const body = { ...structuredClone(terminalUsage) }, before = structuredClone(body);
		await service().settle(auth, frozenAttempt.id, body, terminalUsage.settlementKey);
		expect(accounting.settle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
			assignmentAttempt: 1, activeSeconds: 2, elapsedSeconds: 3, usageActual: terminalUsage.usageActual }));
		expect(body).toEqual(before);
	});
	it('denies coercible measured seconds and attempt values before calling the settlement owner', async () => {
		const outcomes: string[] = [];
		for (const change of [{ activeSeconds: '2' }, { elapsedSeconds: '3' }, { assignmentAttempt: '1' }, { activeSeconds: true }]) {
			try { await service().settle(auth, frozenAttempt.id, { ...terminalUsage, ...change }, terminalUsage.settlementKey); outcomes.push('ADMITTED'); }
			catch { outcomes.push('DENIED'); }
		}
		expect({ outcomes, writes: accounting.settle.mock.calls.length }).toEqual({ outcomes: Array(4).fill('DENIED'), writes: 0 });
	});
	it('denies a provider principal conflicting with the frozen assignment owner even within its membership', async () => {
		await expect(service().settle({ principal: { ...auth.principal, capacityProviderId: 'foreign-provider' } },
			frozenAttempt.id, { ...structuredClone(terminalUsage) }, terminalUsage.settlementKey)).rejects.toThrow();
		expect(accounting.settle).not.toHaveBeenCalled();
	});
	it('denies unknown and terminal accounting modes on the nonterminal report boundary', async () => {
		const outcomes: string[] = [];
		for (const accountingMode of ['unknown', 'aggregate', {}, true]) {
			try { await service().reportUsage(auth, frozenAttempt.id, { assignmentAttempt: 1, usageDimension: 'checkpoint',
				accountingMode, activeSeconds: 0, elapsedSeconds: 0, usageActual: terminalUsage.usageActual }, 'checkpoint-key'); outcomes.push('ADMITTED'); }
			catch { outcomes.push('DENIED'); }
		}
		expect({ outcomes, writes: accounting.report.mock.calls.length }).toEqual({ outcomes: Array(4).fill('DENIED'), writes: 0 });
	});
	it('denies missing credentials scopes and unknown membership assignments without calling accounting', async () => {
		await expect(service().settle(null, frozenAttempt.id, { ...terminalUsage }, 'key')).rejects.toMatchObject({ status: 401 });
		await expect(service().settle({ principal: { ...auth.principal, scopes: [] } }, frozenAttempt.id, { ...terminalUsage }, 'key'))
			.rejects.toMatchObject({ status: 403 });
		const missing = createProviderAssignmentService({ first: vi.fn().mockResolvedValue(null) } as never);
		await expect(missing.settle(auth, frozenAttempt.id, { ...terminalUsage }, 'key')).rejects.toMatchObject({ status: 404 });
		expect(accounting.settle).not.toHaveBeenCalled();
	});
});
