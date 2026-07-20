import { describe, expect, it, vi } from 'vitest';
import {
	listRecentTaskUsageActuals,
	listTaskUsageActualsPage,
	serializeTaskUsageActualRow,
} from '../../src/api/capacity/repositories/task-usage.ts';

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: 'usage-a',
		idempotency_key: 'usage-report-a',
		task_id: null,
		work_day_id: 'workday-a',
		project_id: 'project-a',
		task_signature: 'engineering:planning',
		execution_profile_id: 'standard-code-model',
		assignment_id: 'assignment-a',
		assignment_attempt: 0,
		usage_dimension: 'aggregate',
		accounting_mode: 'aggregate',
		mode_run_id: 'mode-run-a',
		mode: 'planning',
		capacity_provider_id: 'provider-a',
		execution_provider_id: 'codex-a',
		business_model: 'credit',
		model_name: 'codex',
		input_tokens: 10,
		output_tokens: 5,
		cached_input_tokens: 2,
		quota_minutes: null,
		wall_minutes: 1,
		files_opened: 2,
		files_changed: 1,
		diff_lines_added: 3,
		diff_lines_removed: 1,
		test_runs: 1,
		retry_count: 0,
		actual_credits: 1.5,
		actual_usd: null,
		credit_formula_version: 'treeseed.provider-settlement.v1',
		actual_credit_source: 'provider_settlement',
		native_usage_json: '{"wallMinutes":1}',
		metadata_json: '{"settlementKey":"settlement-a"}',
		created_at: '2026-07-17T12:00:00.000Z',
		...overrides,
	};
}

describe('task usage repository', () => {
	it('returns strict bounded keyset pages without hiding storage uncertainty', async () => {
		const all = vi.fn().mockResolvedValue([row(), row({ id: 'usage-b', created_at: '2026-07-17T11:00:00.000Z' })]);
		const database = { ensureInitialized: vi.fn(), all } as never;
		const page = await listTaskUsageActualsPage(database, 'project-a', { workDayId: 'workday-a', limit: 1 });
		expect(page.items).toHaveLength(1);
		expect(page.items[0]).toMatchObject({ id: 'usage-a', assignmentId: 'assignment-a', actualCredits: 1.5 });
		expect(page.page).toMatchObject({ limit: 1, hasMore: true });
		expect(page.page.nextCursor).toEqual(expect.any(String));
		expect(all.mock.calls[0]?.[0]).toContain('work_day_id = ?');
		expect(all.mock.calls[0]?.[1]).toEqual(['project-a', 'workday-a', 2]);

		const storageFailure = new Error('usage storage unavailable');
		await expect(listTaskUsageActualsPage({
			ensureInitialized: vi.fn(),
			all: vi.fn(async () => { throw storageFailure; }),
		} as never, 'project-a')).rejects.toBe(storageFailure);
	});

	it('fails closed for malformed durable usage evidence', () => {
		expect(() => serializeTaskUsageActualRow(row({ metadata_json: '{' })))
			.toThrowError(expect.objectContaining({ code: 'capacity_task_usage_corrupt' }));
		expect(() => serializeTaskUsageActualRow(row({ actual_credits: -1 })))
			.toThrowError(expect.objectContaining({ code: 'capacity_task_usage_corrupt' }));
		expect(() => serializeTaskUsageActualRow(row({ execution_profile_id: null })))
			.toThrowError(expect.objectContaining({ code: 'capacity_task_usage_corrupt' }));
		expect(() => serializeTaskUsageActualRow(row({ mode: 'execute' })))
			.toThrowError(expect.objectContaining({ code: 'capacity_task_usage_corrupt' }));
	});

	it('requires an explicit scope for recent learning and diagnostic reads', async () => {
		const all = vi.fn();
		await expect(listRecentTaskUsageActuals({ ensureInitialized: vi.fn(), all } as never, {}))
			.rejects.toMatchObject({ code: 'capacity_task_usage_scope_required' });
		expect(all).not.toHaveBeenCalled();
	});
});
