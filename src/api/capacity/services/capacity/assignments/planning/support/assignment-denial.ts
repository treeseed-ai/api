import type { CapacityGovernanceDatabase } from '../../../../../database.ts';
import { CapacityAuditRepository } from '../../../../../repositories/support/audit.ts';
import type { ProviderLeasePrincipal } from '../../../../accounts/lease-authority-service.ts';
import { assignmentErrorCode, type AssignmentJsonRecord } from './assignment-function-support.ts';

export async function recordAssignmentDenial(
	store: CapacityGovernanceDatabase,
	principal: ProviderLeasePrincipal,
	demandId: string,
	error: unknown,
	now: string,
) {
	const code = assignmentErrorCode(error);
	const details = error && typeof error === 'object' && 'details' in error
		&& error.details && typeof error.details === 'object' && !Array.isArray(error.details)
		? error.details as AssignmentJsonRecord
		: {};
	await new CapacityAuditRepository(store).record({
		id: `audit:${demandId}:${code}`, teamId: principal.teamId, providerId: principal.capacityProviderId,
		membershipId: principal.membershipId, actorType: 'provider-membership', actorId: principal.membershipId,
		action: 'assignment-function.denied', resourceType: 'capacity-workday-demand', resourceId: demandId,
		idempotencyKey: `${demandId}:${code}`,
		metadata: { reasons: [code], message: error instanceof Error ? error.message : String(error), details },
		now,
	});
}
