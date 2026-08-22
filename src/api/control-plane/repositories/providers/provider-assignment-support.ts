import type { CapacityGovernanceDatabase } from '../../../capacity/database.ts';
import { CapacityGovernanceError } from '../../../capacity/database.ts';
import type { ProviderPrincipal } from './provider-runtime-service.ts';

export interface ProviderAssignmentStore extends CapacityGovernanceDatabase {
	leaseNextProviderAssignment(principal: ProviderPrincipal, input: Record<string, unknown>): Promise<Record<string, unknown>>;
	getProviderAssignment(teamId: string, assignmentId: string): Promise<Record<string, unknown> | null>;
	renewProviderAssignmentLease(principal: ProviderPrincipal, assignmentId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	returnProviderAssignment(principal: ProviderPrincipal, assignmentId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	completeProviderAssignment(principal: ProviderPrincipal, assignmentId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	preflightProviderAssignmentCompletion(principal: ProviderPrincipal, assignmentId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
	failProviderAssignment(principal: ProviderPrincipal, assignmentId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	createAgentModeRun(input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	createCapacityWorkdayEvent?(teamId: string, runId: string, input: Record<string, unknown>): Promise<unknown>;
}

export function assertProviderOwnsAssignment(assignment: Record<string, unknown> | null, principal: ProviderPrincipal, action: string) {
	if (!assignment) throw new CapacityGovernanceError('provider_assignment_not_found', 'Unknown assignment.', 404);
	if (assignment.capacityProviderId !== principal.capacityProviderId) throw new CapacityGovernanceError('provider_assignment_forbidden', `Provider cannot ${action} this assignment.`, 403);
	return assignment;
}

export function assignmentRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function assignmentActivityType(assignment: Record<string, unknown>): unknown {
	const decision = assignmentRecord(assignment.decisionInput);
	return decision.activityType ?? assignmentRecord(decision.metadata).activityType
		?? assignmentRecord(decision.input).activityType ?? assignmentRecord(assignment.metadata).activityType;
}
