import { describe, expect, it, vi } from 'vitest';
import type { CapacityGovernanceDatabase } from '../../src/api/capacity/database.ts';
import { listExecutionRunsForTeamPage } from '../../src/api/capacity/repositories/execution-run.ts';

describe('execution-run repository', () => {
	it('surfaces telemetry read failure instead of returning an incomplete forensic projection', async () => {
		const all = vi.fn()
			.mockResolvedValueOnce([{
				id: 'mode-run-a',
				team_id: 'team-a',
				project_id: 'project-a',
				provider_assignment_id: 'assignment-a',
				capacity_provider_id: 'provider-a',
				project_agent_class_id: 'class-a',
				mode: 'planning',
				status: 'running',
				created_at: '2026-07-17T12:00:00.000Z',
			}])
			.mockRejectedValueOnce(new Error('telemetry storage unavailable'));
		const database = {
			async ensureInitialized() {},
			all,
		} as unknown as CapacityGovernanceDatabase;

		await expect(listExecutionRunsForTeamPage(database, 'team-a', { limit: 1 }))
			.rejects.toThrow('telemetry storage unavailable');
		expect(all).toHaveBeenCalledTimes(2);
	});
});
