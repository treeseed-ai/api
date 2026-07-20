import { buildCreditConversionProfileFromActuals, DEFAULT_EXECUTION_PROFILE_ID } from '@treeseed/sdk/capacity-usage';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { CreditConversionProfileRepository } from '../repositories/credit-conversion-profile.ts';
import { listRecentTaskUsageActuals } from '../repositories/task-usage.ts';

export interface CreditConversionProfileInput {
	taskSignature: string;
	executionProfileId?: string | null;
	executionProviderKind: string;
	nativeUnit: string;
	formulaVersion?: string;
}

export class CreditConversionProfileService {
	private readonly profiles: CreditConversionProfileRepository;
	constructor(private readonly database: CapacityGovernanceDatabase) { this.profiles = new CreditConversionProfileRepository(database); }
	async upsertFromActuals(input: CreditConversionProfileInput) {
		if (!input?.taskSignature?.trim() || !input.executionProviderKind?.trim() || !input.nativeUnit?.trim()) {
			throw new CapacityGovernanceError('credit_conversion_profile_input_invalid', 'Task signature, execution provider kind, and native unit are required.', 400);
		}
		const taskSignature = input.taskSignature.trim();
		const executionProviderKind = input.executionProviderKind.trim();
		const nativeUnit = input.nativeUnit.trim();
		const profileId = input.executionProfileId?.trim() || DEFAULT_EXECUTION_PROFILE_ID;
		const actuals = (await listRecentTaskUsageActuals(this.database, { taskSignature, executionProfileId: profileId, limit: 200 }))
			.filter((actual) => actual.metadata?.executionProviderKind === executionProviderKind);
		const existing = await this.profiles.get(taskSignature, profileId, executionProviderKind, nativeUnit);
		const profile = buildCreditConversionProfileFromActuals({
			id: existing?.id ?? `${taskSignature}:${profileId}:${executionProviderKind}:${nativeUnit}`,
			taskSignature, executionProfileId: profileId, executionProviderKind,
			nativeUnit, actuals, formulaVersion: input.formulaVersion, now: new Date().toISOString(),
		});
		return this.profiles.upsert({ ...profile, createdAt: existing?.createdAt ?? profile.updatedAt });
	}
}
