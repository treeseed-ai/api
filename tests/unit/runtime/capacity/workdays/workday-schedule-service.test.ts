import { describe, expect, it } from 'vitest';
import { createTestStore } from '../../../../support/api-harness.ts';
import { createCapacityControlPlane } from '../../../../../src/api/capacity/control-plane.ts';
import { CapacityWorkdayScheduleService } from '../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-schedule-service.ts';

describe('capacity workday schedules', () => {
	it('persists normalized selection and enforces optimistic schedule updates', async () => {
		const host = createTestStore(); await host.createTeam({ id: 'team-a', slug: 'team-a', name: 'team-a' });
		const service = new CapacityWorkdayScheduleService(createCapacityControlPlane(host));
		const created = await service.create('team-a', {
			id: 'schedule-a', projectIds: ['project-a'], capacityProviderId: 'provider-a', cadenceSeconds: 300,
			durationSeconds: 120, maxActiveAssignments: 3, availableCredits: 50,
			agentSelection: { classSlugs: ['guide-writing'], agentSlugs: ['writer'], mode: 'intersection' },
			publicationPolicy: { bookIds: ['treeseed-guide'], target: 'staging', simulatedHumanApproval: true },
		});
		expect(created).toMatchObject({ id: 'schedule-a', stateVersion: 1, agentSelection: { classSlugs: ['guide-writing'], agentSlugs: ['writer'] } });
		const paused = await service.update('team-a', 'schedule-a', { stateVersion: 1, status: 'paused' });
		expect(paused).toMatchObject({ status: 'paused', stateVersion: 2 });
		await expect(service.update('team-a', 'schedule-a', { stateVersion: 1, status: 'active' })).rejects.toMatchObject({ code: 'capacity_workday_schedule_version_stale' });
	});
});
