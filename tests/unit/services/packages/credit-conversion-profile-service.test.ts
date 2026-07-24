import { describe, expect, it, vi } from 'vitest';
import { serializeCreditConversionProfileRow } from '../../../../src/api/capacity/repositories/packages/credit-conversion-profile.ts';
import { CreditConversionProfileService } from '../../../../src/api/capacity/services/packages/credit-conversion-profile-service.ts';

function profileRow(overrides: Record<string, unknown> = {}) {
	return {
		id: 'engineering:planning:standard-code-model:codex:wall_minute',
		task_signature: 'engineering:planning', execution_profile_id: 'standard-code-model',
		execution_provider_kind: 'codex', native_unit: 'wall_minute', sample_count: 1,
		completed_sample_count: 1, interrupted_sample_count: 0, native_units_per_credit_p50: 2,
		native_units_per_credit_p90: 2, credits_per_native_unit_p50: 0.5, credits_per_native_unit_p90: 0.5,
		actual_credits_p50: 1, actual_credits_p90: 1, confidence: 'low',
		formula_version: 'treeseed.actual-credits.v1', metadata_json: '{}',
		created_at: '2026-07-18T00:00:00.000Z', updated_at: '2026-07-18T00:00:00.000Z',
		...overrides,
	};
}

function usageRow() {
	return {
		id: 'usage-a', idempotency_key: 'usage-a-report', task_id: null, work_day_id: 'workday-a', project_id: 'project-a',
		task_signature: 'engineering:planning', execution_profile_id: 'standard-code-model', assignment_id: 'assignment-a',
		assignment_attempt: 1, usage_dimension: 'wall_minutes', accounting_mode: 'incremental',
		mode_run_id: 'mode-a', mode: 'planning', capacity_provider_id: 'provider-a', execution_provider_id: 'codex-a', lane_id: null,
		business_model: 'credit', model_name: 'codex', input_tokens: 1, output_tokens: 1, cached_input_tokens: 0,
		quota_minutes: null, wall_minutes: 2, files_opened: 0, files_changed: 0, diff_lines_added: 0,
		diff_lines_removed: 0, test_runs: 0, retry_count: 0, actual_credits: 1, actual_usd: null,
		credit_formula_version: 'treeseed.actual-credits.v1', actual_credit_source: 'provider_settlement',
		native_usage_json: '{"wallMinutes":2}', metadata_json: '{"executionProviderKind":"codex"}',
		created_at: '2026-07-18T00:00:00.000Z',
	};
}

describe('credit conversion profile persistence', () => {
	it('fails closed when durable profile fields are corrupt', () => {
		expect(() => serializeCreditConversionProfileRow(profileRow({ confidence: 'invented' })))
			.toThrowError(expect.objectContaining({ code: 'credit_conversion_profile_corrupt' }));
		expect(() => serializeCreditConversionProfileRow(profileRow({ metadata_json: '[]' })))
			.toThrowError(expect.objectContaining({ code: 'capacity_durable_json_invalid' }));
		expect(() => serializeCreditConversionProfileRow(profileRow({ sample_count: -1 })))
			.toThrowError(expect.objectContaining({ code: 'credit_conversion_profile_corrupt' }));
		expect(() => serializeCreditConversionProfileRow(profileRow({ sample_count: 1, completed_sample_count: 1, interrupted_sample_count: 1 })))
			.toThrowError(expect.objectContaining({ code: 'credit_conversion_profile_corrupt' }));
	});

	it('learns through the canonical SDK builder and PostgreSQL conflict-safe upsert', async () => {
		const first = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(profileRow());
		const run = vi.fn().mockResolvedValue(undefined);
		const database = {
			ensureInitialized: vi.fn(), run, first, all: vi.fn().mockResolvedValue([usageRow()]), batch: vi.fn(),
		};
		const result = await new CreditConversionProfileService(database).upsertFromActuals({
			taskSignature: ' engineering:planning ', executionProviderKind: ' codex ', nativeUnit: ' wall_minute ',
		});
		expect(result).toMatchObject({ taskSignature: 'engineering:planning', executionProviderKind: 'codex', nativeUnitsPerCreditP50: 2 });
		expect(run.mock.calls[0]?.[0]).toContain('ON CONFLICT (task_signature, execution_profile_id, execution_provider_kind, native_unit) DO UPDATE');
		expect(run.mock.calls[0]?.[0]).not.toContain('INSERT OR REPLACE');
		expect(run.mock.calls[0]?.[1]?.[8]).toBe(2);
	});

	it('rejects incomplete learning scope before reading or mutating storage', async () => {
		const database = { ensureInitialized: vi.fn(), run: vi.fn(), first: vi.fn(), all: vi.fn(), batch: vi.fn() };
		await expect(new CreditConversionProfileService(database).upsertFromActuals({
			taskSignature: '', executionProviderKind: 'codex', nativeUnit: 'wall_minute',
		})).rejects.toMatchObject({ code: 'credit_conversion_profile_input_invalid' });
		expect(database.all).not.toHaveBeenCalled();
		expect(database.run).not.toHaveBeenCalled();
	});
});
