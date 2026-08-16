import type { Context } from 'hono';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';
import type { CapacityProviderAccessPrincipal } from '../providers/provider-auth.ts';

export interface ProviderAssignmentStore extends CapacityGovernanceDatabase {
	leaseNextProviderAssignment(principal: CapacityProviderAccessPrincipal, input: Record<string, unknown>): Promise<Record<string, unknown>>;
	getProviderAssignment(teamId: string, assignmentId: string): Promise<Record<string, unknown> | null>;
	renewProviderAssignmentLease(principal: CapacityProviderAccessPrincipal, assignmentId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	returnProviderAssignment(principal: CapacityProviderAccessPrincipal, assignmentId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	completeProviderAssignment(principal: CapacityProviderAccessPrincipal, assignmentId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	preflightProviderAssignmentCompletion(principal: CapacityProviderAccessPrincipal, assignmentId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
	failProviderAssignment(principal: CapacityProviderAccessPrincipal, assignmentId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	createAgentModeRun(input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	createCapacityWorkdayEvent?(teamId: string, runId: string, input: Record<string, unknown>): Promise<unknown>;
	listCapacityWorkdayEventsPage(teamId: string, runId: string, page: { limit: number; cursor: null; afterEventIndex: number }): Promise<{ items: unknown[] }>;
}

export function providerAssignmentErrorResponse(c: Context, error: unknown) {
	if (error instanceof CapacityGovernanceError) {
		return new Response(JSON.stringify({ ok: false, error: error.message, code: error.code, details: error.details }), { status: error.status, headers: { 'content-type': 'application/json' } });
	}
	throw error;
}

export function assertProviderOwnsAssignment(assignment: Record<string, unknown> | null, principal: CapacityProviderAccessPrincipal, action: string) {
	if (!assignment) throw new CapacityGovernanceError('provider_assignment_not_found', 'Unknown assignment.', 404);
	if (assignment.capacityProviderId !== principal.capacityProviderId) {
		throw new CapacityGovernanceError('provider_assignment_forbidden', `Provider cannot ${action} this assignment.`, 403);
	}
	return assignment;
}

export function assignmentRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function assignmentActivityType(assignment: Record<string, unknown>): unknown {
	const decision = assignmentRecord(assignment.decisionInput);
	return decision.activityType
		?? assignmentRecord(decision.metadata).activityType
		?? assignmentRecord(decision.input).activityType
		?? assignmentRecord(assignment.metadata).activityType;
}
