import { describe, expect, it, vi } from 'vitest';
import { terminalizeCapacityWorkdayAssignments } from '../../../../../../src/api/capacity/services/capacity/workdays/lifecycle/workday-assignment-terminalization-service.ts';
import { MAX_CAPACITY_PAGE_LIMIT } from '@treeseed/sdk/capacity-pagination';
import type { CapacityGovernanceDatabase } from '../../../../../../src/api/capacity/database.ts';

describe('workday terminalization graph custody', () => {
	it('retains an orphan active graph node as unfinished even when no assignment row remains', async () => {
		const database: CapacityGovernanceDatabase = {
			ensureInitialized: async () => undefined,
			first: async <T extends Record<string, unknown>>(): Promise<T | null> => null,
			all: async <T extends Record<string, unknown>>(): Promise<T[]> => [],
			run: async () => undefined, batch: async () => undefined,
		};
		vi.spyOn(database, 'first').mockResolvedValue({ total: 1 });
		vi.spyOn(database, 'run'); vi.spyOn(database, 'batch');
		const result = await terminalizeCapacityWorkdayAssignments(database, 'team', 'run', { now: '2026-09-20T00:00:00.000Z' });
		expect(result.unfinishedAssignmentCount).toBe(1);
		expect(database.first).toHaveBeenCalledWith(expect.stringContaining("node.status IN ('assigned','running')"), ['team', 'run']);
		expect(database.run).toHaveBeenCalledTimes(1); expect(database.batch).not.toHaveBeenCalled();
	});
	it('keeps an in-flight lease outside immediate stop terminalization until provider teardown can report', async () => {
		const now = '2026-09-28T09:14:15.670Z';
		const preserveActiveLeasesUntil = '2026-09-28T09:19:15.670Z';
		const database = {
			ensureInitialized: vi.fn(async () => undefined),
			first: vi.fn(async (_sql: string, _params?: unknown[]) => ({ assignment_count: 1, completed_assignments: 0, failed_assignments: 0, unfinished_assignments: 1 })),
			all: vi.fn(async (_sql: string, _params?: unknown[]) => []),
			run: vi.fn(async () => ({})),
		};
		await terminalizeCapacityWorkdayAssignments(database as never, 'team', 'run', { now, preserveActiveLeasesUntil });
		const activeSelection = database.all.mock.calls.find(([sql]) => sql.includes('assignment.status NOT IN'));
		expect(activeSelection).toBeDefined();
		expect(activeSelection?.[0]).toContain("assignment.status = 'leased' AND assignment.lease_state = 'leased'");
		expect(activeSelection?.[1]).toEqual(['team', 'run', preserveActiveLeasesUntil, now, now, MAX_CAPACITY_PAGE_LIMIT]);
		expect(database.run).toHaveBeenCalledWith(expect.stringContaining("status IN ('proposed','blocked','ready')"),
			[now, 'team', 'run']);
	});

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
