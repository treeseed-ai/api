import { describe, expect, it, vi } from 'vitest';
import { assignmentWorkdayRunId } from '../../../../src/api/control-plane/repositories/providers/provider-assignment-support.ts';
import { createProviderAssignmentService, normalizeStoredTimestamp } from '../../../../src/api/control-plane/repositories/providers/provider-assignment-service.ts';

describe('provider assignment timestamps', () => {
	it('normalizes database Date values before returning communication receipts', () => {
		expect(normalizeStoredTimestamp(new Date('2026-08-31T05:00:00.123Z'))).toBe('2026-08-31T05:00:00.123Z');
		expect(normalizeStoredTimestamp('2026-08-31 05:00:00.123+00')).toBe('2026-08-31T05:00:00.123Z');
		expect(normalizeStoredTimestamp(null)).toBe('');
	});
});

describe('provider assignment workday identity', () => {
	it('uses the canonical durable assignment field when metadata does not duplicate it', () => {
		expect(assignmentWorkdayRunId({ workDayId: 'workday-run-1', metadata: {} })).toBe('workday-run-1');
	});

	it('continues to read the planning metadata representation', () => {
		expect(assignmentWorkdayRunId({ metadata: { workdayRunId: 'workday-run-1' } })).toBe('workday-run-1');
	});

	it('keeps the durable assignment field authoritative', () => {
		expect(assignmentWorkdayRunId({ workDayId: 'workday-run-2', metadata: { workdayRunId: 'stale-run' } })).toBe('workday-run-2');
	});

	it('records provider runtime events against the durable workday field', async () => {
		const createCapacityWorkdayEvent = vi.fn().mockResolvedValue({ id: 'event-1' });
		const service = createProviderAssignmentService({
			getProviderAssignment: vi.fn().mockResolvedValue({
				id: 'assignment-1', capacityProviderId: 'provider-1', workDayId: 'workday-run-1', metadata: {},
			}),
			createCapacityWorkdayEvent,
		} as never);
		await service.createEvent({ principal: {
			membershipId: 'membership-1', teamId: 'team-1', capacityProviderId: 'provider-1', scopes: ['provider:assignments:write'],
		} }, 'assignment-1', {
			id: 'event-1', eventType: 'provider.execution.started', component: 'provider-runner', message: 'Execution started.', status: 'active',
		});
		expect(createCapacityWorkdayEvent).toHaveBeenCalledWith('team-1', 'workday-run-1', expect.objectContaining({ assignmentId: 'assignment-1' }));
	});
});
