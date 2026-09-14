import { describe, expect, it, vi } from 'vitest';
import { CapacityWorkdayDemandRepository, capacityDemandRunDeadlineOpen } from '../../../../../src/api/capacity/repositories/capacity/workdays/workday-demand.ts';

describe('provisioning demand selection', () => {
	it('retries only active unleased assignments and cannot let historical failures starve new work', async () => {
		const all = vi.fn(async () => []);
		const repository = new CapacityWorkdayDemandRepository({ all } as never);
		await repository.listProvisioning('team', 'provider');
		const sql = String(all.mock.calls[0]?.[0]);
		expect(sql).toContain("run.status = 'running'");
		expect(sql).toContain("assignment.status = 'pending'");
		expect(sql).toContain("assignment.lease_state = 'unleased'");
	});
});

describe('claimable workday deadline', () => {
	it('excludes expired runs and accepts a current or unbounded run', () => {
		const now = '2026-09-12T12:00:00.000Z';
		expect(capacityDemandRunDeadlineOpen({ deadlineAt: '2026-09-12T11:59:59.000Z' }, now)).toBe(false);
		expect(capacityDemandRunDeadlineOpen(JSON.stringify({ deadlineAt: '2026-09-12T12:00:01.000Z' }), now)).toBe(true);
		expect(capacityDemandRunDeadlineOpen({}, now)).toBe(true);
	});
});
