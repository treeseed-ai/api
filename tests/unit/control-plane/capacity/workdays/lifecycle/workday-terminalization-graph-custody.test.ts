import { describe, expect, it, vi } from 'vitest';
import { terminalizeCapacityWorkdayAssignments } from '../../../../../../src/api/capacity/services/capacity/workdays/lifecycle/workday-assignment-terminalization-service.ts';

describe('workday terminalization graph custody', () => {
	it('cancels unclaimed graph nodes without touching retired demand rows', async () => {
		const run = vi.fn(async (_sql: string, _params?: unknown[]) => ({}));
		const database = {
			ensureInitialized: vi.fn(async () => undefined),
			first: vi.fn(async (_sql: string, _params?: unknown[]) => ({ assignment_count: 0, completed_assignments: 0, failed_assignments: 0, unfinished_assignments: 0 })),
			all: vi.fn(async (_sql: string, _params?: unknown[]) => []), run,
		};
		await terminalizeCapacityWorkdayAssignments(database as never, 'team', 'run', { now: '2026-09-20T00:00:00.000Z' });
		expect(run).toHaveBeenCalledOnce();
		const [sql, params] = run.mock.calls[0]!;
		expect(sql).toContain("UPDATE execution_nodes SET status='cancelled'");
		expect(sql).toContain("status IN ('proposed','blocked','ready')");
		expect(params).toEqual(['2026-09-20T00:00:00.000Z', 'team', 'run']);
		for (const [query] of [...database.first.mock.calls, ...database.all.mock.calls]) {
			expect(query).not.toContain('envelope.id = assignment.work_day_id');
			if (query.includes('capacity_provider_assignments assignment')) expect(query).toContain('run.id = assignment.work_day_id');
		}
	});
});
