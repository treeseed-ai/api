import type { CapacityGovernanceDatabase } from '../../../capacity/database.ts';
import { CapacityGovernanceError } from '../../../capacity/database.ts';
import type { ProviderPrincipal } from './provider-runtime-service.ts';

export interface ProviderAssignmentStore extends CapacityGovernanceDatabase {
	leaseNextProviderAssignment(principal: ProviderPrincipal, input: Record<string, unknown>): Promise<Record<string, unknown>>;
	getProviderAssignment(teamId: string, assignmentId: string): Promise<Record<string, unknown> | null>;
	renewProviderAssignmentLease(principal: ProviderPrincipal, assignmentId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	returnProviderAssignment(principal: ProviderPrincipal, assignmentId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	completeProviderAssignment(principal: ProviderPrincipal, assignmentId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	failProviderAssignment(principal: ProviderPrincipal, assignmentId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
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
