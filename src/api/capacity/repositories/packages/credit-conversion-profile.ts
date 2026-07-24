import type { CreditConversionProfile } from '@treeseed/sdk';
import { DEFAULT_EXECUTION_PROFILE_ID } from '@treeseed/sdk/capacity-usage';
import { decodeDurableJsonObject } from '../../durable-json.ts';
import type { CapacityGovernanceDatabase } from '../../database.ts';
import { CapacityGovernanceError } from '../../database.ts';

type Row = Record<string, unknown>;
const CONFIDENCE = new Set(['low', 'medium', 'high']);
function required(row: Row, column: string) {
	const value = row[column];
	if (typeof value !== 'string' || !value) throw new CapacityGovernanceError('credit_conversion_profile_corrupt', `Credit conversion profile has invalid ${column}.`, 500, { profileId: typeof row.id === 'string' ? row.id : null, column });
	return value;
}
function count(row: Row, column: string) {
	const value = Number(row[column]);
	if (!Number.isInteger(value) || value < 0) throw new CapacityGovernanceError('credit_conversion_profile_corrupt', `Credit conversion profile has invalid ${column}.`, 500, { profileId: row.id, column });
	return value;
}
function nullableNumber(row: Row, column: string) {
	if (row[column] == null) return null;
	const value = Number(row[column]);
	if (!Number.isFinite(value) || value < 0) throw new CapacityGovernanceError('credit_conversion_profile_corrupt', `Credit conversion profile has invalid ${column}.`, 500, { profileId: row.id, column });
	return value;
}

export function serializeCreditConversionProfileRow(row: Row | null): CreditConversionProfile | null {
	if (!row) return null;
	const confidence = required(row, 'confidence');
	if (!CONFIDENCE.has(confidence)) throw new CapacityGovernanceError('credit_conversion_profile_corrupt', `Credit conversion profile has invalid confidence ${confidence}.`, 500, { profileId: row.id });
	const sampleCount = count(row, 'sample_count');
	const completedSampleCount = count(row, 'completed_sample_count');
	const interruptedSampleCount = count(row, 'interrupted_sample_count');
	if (completedSampleCount + interruptedSampleCount > sampleCount) {
		throw new CapacityGovernanceError('credit_conversion_profile_corrupt', 'Credit conversion profile sample counts are inconsistent.', 500, { profileId: row.id });
	}
	return {
		id: required(row, 'id'), taskSignature: required(row, 'task_signature'),
		executionProfileId: required(row, 'execution_profile_id') || DEFAULT_EXECUTION_PROFILE_ID,
		executionProviderKind: required(row, 'execution_provider_kind'), nativeUnit: required(row, 'native_unit'),
		sampleCount, completedSampleCount, interruptedSampleCount,
		nativeUnitsPerCreditP50: nullableNumber(row, 'native_units_per_credit_p50'), nativeUnitsPerCreditP90: nullableNumber(row, 'native_units_per_credit_p90'),
		creditsPerNativeUnitP50: nullableNumber(row, 'credits_per_native_unit_p50'), creditsPerNativeUnitP90: nullableNumber(row, 'credits_per_native_unit_p90'),
		actualCreditsP50: nullableNumber(row, 'actual_credits_p50'), actualCreditsP90: nullableNumber(row, 'actual_credits_p90'),
		confidence: confidence as CreditConversionProfile['confidence'], formulaVersion: required(row, 'formula_version'),
		metadata: decodeDurableJsonObject(row.metadata_json, { owner: 'credit conversion profile', ownerId: String(row.id), column: 'metadata_json' }),
		createdAt: required(row, 'created_at'), updatedAt: required(row, 'updated_at'),
	};
}

export class CreditConversionProfileRepository {
	constructor(private readonly database: CapacityGovernanceDatabase) {}
	async get(taskSignature: string, executionProfileId: string, executionProviderKind: string, nativeUnit: string) {
		await this.database.ensureInitialized();
		return serializeCreditConversionProfileRow(await this.database.first(`SELECT * FROM credit_conversion_profiles WHERE task_signature = ? AND execution_profile_id = ? AND execution_provider_kind = ? AND native_unit = ? LIMIT 1`,
			[taskSignature, executionProfileId || DEFAULT_EXECUTION_PROFILE_ID, executionProviderKind, nativeUnit]));
	}
	async best(executionProviderKind: string, nativeUnit: string) {
		await this.database.ensureInitialized();
		return serializeCreditConversionProfileRow(await this.database.first(`SELECT * FROM credit_conversion_profiles WHERE execution_provider_kind = ? AND native_unit = ?
			ORDER BY CASE confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, completed_sample_count DESC, sample_count DESC, updated_at DESC LIMIT 1`,
			[executionProviderKind, nativeUnit]));
	}
	async upsert(profile: CreditConversionProfile) {
		await this.database.ensureInitialized();
		if (!profile.id || !profile.createdAt) {
			throw new CapacityGovernanceError('credit_conversion_profile_input_invalid', 'Credit conversion profile ID and creation time are required.', 400);
		}
		await this.database.run(`INSERT INTO credit_conversion_profiles (id, task_signature, execution_profile_id, execution_provider_kind, native_unit,
			sample_count, completed_sample_count, interrupted_sample_count, native_units_per_credit_p50, native_units_per_credit_p90,
			credits_per_native_unit_p50, credits_per_native_unit_p90, actual_credits_p50, actual_credits_p90, confidence, formula_version, metadata_json, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (task_signature, execution_profile_id, execution_provider_kind, native_unit) DO UPDATE SET
			sample_count = EXCLUDED.sample_count, completed_sample_count = EXCLUDED.completed_sample_count, interrupted_sample_count = EXCLUDED.interrupted_sample_count,
			native_units_per_credit_p50 = EXCLUDED.native_units_per_credit_p50, native_units_per_credit_p90 = EXCLUDED.native_units_per_credit_p90,
			credits_per_native_unit_p50 = EXCLUDED.credits_per_native_unit_p50, credits_per_native_unit_p90 = EXCLUDED.credits_per_native_unit_p90,
			actual_credits_p50 = EXCLUDED.actual_credits_p50, actual_credits_p90 = EXCLUDED.actual_credits_p90, confidence = EXCLUDED.confidence,
			formula_version = EXCLUDED.formula_version, metadata_json = EXCLUDED.metadata_json, updated_at = EXCLUDED.updated_at`, [
			profile.id, profile.taskSignature, profile.executionProfileId || DEFAULT_EXECUTION_PROFILE_ID, profile.executionProviderKind, profile.nativeUnit,
			profile.sampleCount, profile.completedSampleCount, profile.interruptedSampleCount ?? 0, profile.nativeUnitsPerCreditP50, profile.nativeUnitsPerCreditP90,
			profile.creditsPerNativeUnitP50, profile.creditsPerNativeUnitP90, profile.actualCreditsP50, profile.actualCreditsP90, profile.confidence,
			profile.formulaVersion, JSON.stringify(profile.metadata ?? {}), profile.createdAt, profile.updatedAt,
		]);
		return this.get(profile.taskSignature, profile.executionProfileId, profile.executionProviderKind, profile.nativeUnit);
	}
}
