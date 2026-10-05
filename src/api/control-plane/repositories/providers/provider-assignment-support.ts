import type { CapacityGovernanceDatabase } from '../../../capacity/database.ts';
import { CapacityGovernanceError } from '../../../capacity/database.ts';
import type { ProviderPrincipal } from './provider-runtime-service.ts';
import type { ProviderAssignmentLeaseResult } from '../../../capacity/services/capacity/assignments/lifecycle/assignment-lease-service.ts';
import type { ProviderAssignmentLifecycleMutationResult } from '../../../capacity/services/capacity/assignments/lifecycle/assignment-lifecycle-service.ts';
import type { ProviderAssignment } from '@treeseed/sdk/agent-capacity';

type AssignmentObservation = ProviderAssignment | Record<string, unknown>;
type AssignmentMutation = ProviderAssignmentLifecycleMutationResult | Record<string, unknown>;

export interface ProviderAssignmentStore extends CapacityGovernanceDatabase {
	leaseNextProviderAssignment(principal: ProviderPrincipal, input: Record<string, unknown>): Promise<Partial<ProviderAssignmentLeaseResult>>;
	getProviderAssignment(teamId: string, assignmentId: string): Promise<AssignmentObservation | null>;
	renewProviderAssignmentLease(principal: ProviderPrincipal, assignmentId: string, input: Record<string, unknown>): Promise<AssignmentMutation | null>;
	returnProviderAssignment(principal: ProviderPrincipal, assignmentId: string, input: Record<string, unknown>): Promise<AssignmentMutation | null>;
	completeProviderAssignment(principal: ProviderPrincipal, assignmentId: string, input: Record<string, unknown>): Promise<AssignmentMutation | null>;
	failProviderAssignment(principal: ProviderPrincipal, assignmentId: string, input: Record<string, unknown>): Promise<AssignmentMutation | null>;
	createCapacityWorkdayEvent?(teamId: string, runId: string, input: Record<string, unknown>): Promise<unknown>;
}

export function assertProviderOwnsAssignment(value: AssignmentObservation | null, principal: ProviderPrincipal, action: string) {
	if (!value) throw new CapacityGovernanceError('provider_assignment_not_found', 'Unknown assignment.', 404);
	const assignment = assignmentRecord(value);
	if (assignment.capacityProviderId !== principal.capacityProviderId) throw new CapacityGovernanceError('provider_assignment_forbidden', `Provider cannot ${action} this assignment.`, 403);
	return assignment;
}

export function assignmentRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function assignmentActivityType(assignment: Record<string, unknown>): unknown {
	const raw = assignment.assignmentAttempt ?? assignment.assignment_attempt_json;
	let attempt = assignmentRecord(raw);
	if (typeof raw === 'string') {
		try { attempt = assignmentRecord(JSON.parse(raw)); }
		catch { return null; }
	}
	return assignmentRecord(attempt.effectiveProfile).activity ?? null;
}

export function assignmentWorkdayRunId(assignment: Record<string, unknown>): string | null {
	const value = assignment.workDayId ?? assignment.work_day_id;
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}
