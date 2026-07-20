import { evaluateCapacityAdmission } from '@treeseed/sdk/agent-capacity/allocation';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import {
	loadCapacityAdmissionState,
	type CapacityAdmissionStateRequest,
} from './admission-state-service.ts';

export async function explainCapacityAllocation(
	database: CapacityGovernanceDatabase,
	allocationSetId: string,
	request: CapacityAdmissionStateRequest,
) {
	const admission = await loadCapacityAdmissionState(database, request);
	if (admission.allocationSet.id !== allocationSetId) {
		throw new CapacityGovernanceError(
			'capacity_allocation_not_effective',
			'The requested allocation set is not the effective policy for this admission.',
			409,
			{ allocationSetId, effectiveAllocationSetId: admission.allocationSet.id },
		);
	}
	return {
		request,
		decision: evaluateCapacityAdmission(admission),
	};
}
