import { describe, expect, it, vi } from 'vitest';
import { CapacityWorkdayRecoveryRepository } from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-recovery.ts';

describe('workday recovery graph custody', () => {
	it('finds ready graph work and assignment evidence by the canonical workday IDs', async () => {
		const queries: string[] = [];
		const database = {
			ensureInitialized: vi.fn(async () => undefined),
			first: vi.fn(async (query: string) => {
				queries.push(query);
				return query.includes('FROM execution_nodes') ? { id: 'ready-node' } : null;
			}),
		};
		const run = { id: 'run', teamId: 'team', actual: {} };
		const state = await new CapacityWorkdayRecoveryRepository(database as never).recoveryState(run as never);
		expect(state).toMatchObject({ hasReadyNodes: true, hasUnfinishedAssignments: false });
		expect(queries.join('\n')).not.toContain('capacity_workday_demands');
		expect(queries.join('\n')).toContain('assignment.work_day_id = ?');
		expect(queries.join('\n')).toContain("workday_id = ? AND status = 'ready'");
	});
});
