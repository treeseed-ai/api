import { describe, expect, it, vi } from 'vitest';
import { terminalizeCapacityWorkdayAssignments } from '../../../src/api/capacity/services/workday-assignment-terminalization-service.ts';
import type { CapacityGovernanceDatabase } from '../../../src/api/capacity/database.ts';

describe('workday assignment terminalization service', () => {
	it('leaves assignment and mode-run state recoverable when settlement cannot commit', async () => {
		const run = vi.fn(async () => undefined);
		const database = {
			ensureInitialized: vi.fn(async () => undefined),
			run,
			batch: vi.fn(async () => undefined),
			first: vi.fn(async <T extends Record<string, unknown>>(query: string) => {
				if (query.includes('COUNT(*) AS assignment_count')) {
					return { assignment_count: 1, completed_assignments: 0, failed_assignments: 0, unfinished_assignments: 1 } as unknown as T;
				}
				return null;
			}),
			all: vi.fn(async <T extends Record<string, unknown>>(query: string) => (query.includes('SELECT assignment.id, assignment.membership_id')
				? [{ id: 'assignment-a', membership_id: 'membership-a', reservation_id: 'reservation-missing', state_version: 4 }]
				: []) as unknown as T[]),
		};

		await expect(terminalizeCapacityWorkdayAssignments(database as unknown as CapacityGovernanceDatabase, 'team-a', 'run-a', {
			now: '2026-07-17T18:00:00.000Z',
		})).rejects.toMatchObject({ code: 'capacity_reservation_not_found' });
		expect(run).not.toHaveBeenCalled();
	});
});
