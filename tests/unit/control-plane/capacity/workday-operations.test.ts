import { describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createWorkdayOperations } from '../../../../src/api/control-plane/catalog/capacity/workdays.ts';
import { createWorkdayService } from '../../../../src/api/control-plane/repositories/capacity/workday-service.ts';

const principal = { id: 'user-1' };

describe('workday catalog operations', () => {
	it('binds only the eight team-portfolio workday operations', () => {
		const workdays = Object.fromEntries(['list', 'preflight', 'start', 'show', 'events', 'schedules', 'createSchedule', 'updateSchedule']
			.map((name) => [name, vi.fn()])) as any;
		expect(createWorkdayOperations({ workdays }).map((operation) => operation.binding)).toEqual([
			CONTROL_PLANE_OPERATIONS.workdays.list, CONTROL_PLANE_OPERATIONS.workdays.preflight,
			CONTROL_PLANE_OPERATIONS.workdays.start, CONTROL_PLANE_OPERATIONS.workdays.show,
			CONTROL_PLANE_OPERATIONS.workdays.events, CONTROL_PLANE_OPERATIONS.workdays.schedules,
			CONTROL_PLANE_OPERATIONS.workdays.createSchedule, CONTROL_PLANE_OPERATIONS.workdays.updateSchedule,
		]);
	});

	it('requires the exact schedule generation before mutation', async () => {
		const store = {
			principalCanAccessTeam: vi.fn(async () => true),
			getTeamAccessSummary: vi.fn(async () => ({ permissions: ['teams:manage:team'] })),
			getCapacityWorkdaySchedule: vi.fn(async () => ({ id: 'schedule-1', stateVersion: 4 })),
			updateCapacityWorkdaySchedule: vi.fn(),
		};
		const workdays = createWorkdayService(store);
		await expect(workdays.updateSchedule(principal, 'team-1', 'schedule-1', { status: 'paused' }, '3'))
			.rejects.toMatchObject({ status: 412, code: 'workday_schedule_precondition_failed' });
		expect(store.updateCapacityWorkdaySchedule).not.toHaveBeenCalled();
	});
});
