import type { StructuredAgentEstimateRecord } from '@treeseed/sdk/agent-capacity';
import { CapacityGovernanceError, type CapacityGovernanceDatabase } from '../../../../database.ts';
import type { DurableProviderAssignment } from '../../../../repositories/capacity/assignments/assignment.ts';

type JsonRecord = Record<string, unknown>;

export interface AssignmentPlanningOutputStore extends CapacityGovernanceDatabase {
	getStructuredAgentEstimate(id: string): Promise<StructuredAgentEstimateRecord | null>;
	createStructuredAgentEstimate(decisionId: string, input: JsonRecord): Promise<StructuredAgentEstimateRecord | null>;
}

function record(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

export async function projectCompletedPlanningOutputs(
	store: AssignmentPlanningOutputStore,
	assignment: DurableProviderAssignment,
	input: JsonRecord,
) {
	if (assignment.mode !== 'planning') return null;
	const output = record(input.output);
	const planningInputRequestId = text(record(record(assignment.decisionInput).input).planningInputRequestId);
	if (planningInputRequestId) await store.run(
		`UPDATE planning_input_requests SET status = 'complete', response_json = ?, completed_at = COALESCE(completed_at, ?)
		 WHERE id = ? AND team_id = ? AND project_id = ? AND status IN ('requested','complete')`,
		[JSON.stringify({ assignmentId: assignment.id, summary: output.summary ?? null }), new Date().toISOString(), planningInputRequestId, assignment.teamId, assignment.projectId],
	);
	const estimate = record(record(output.metadata).structuredEstimate);
	if (!Object.keys(estimate).length) return null;
	const id = text(estimate.id);
	const decisionId = text(estimate.decisionId ?? assignment.decisionId);
	if (!id || !decisionId || text(estimate.teamId) !== assignment.teamId || text(estimate.projectId) !== assignment.projectId
		|| text(estimate.agentId) !== text(assignment.agentId)) {
		throw new CapacityGovernanceError('assignment_planning_estimate_scope_invalid', 'Planning estimate output does not match its assignment scope.', 409, { assignmentId: assignment.id, estimateId: id || null });
	}
	const existing = await store.getStructuredAgentEstimate(id);
	if (existing) {
		if (existing.decisionId === decisionId && existing.projectId === assignment.projectId && existing.metadata?.assignmentId === assignment.id) return existing;
		throw new CapacityGovernanceError('assignment_planning_estimate_conflict', 'Planning estimate id is already owned by another assignment scope.', 409, { assignmentId: assignment.id, estimateId: id });
	}
	return store.createStructuredAgentEstimate(decisionId, {
		...estimate,
		status: 'submitted',
		metadata: { ...record(estimate.metadata), assignmentId: assignment.id },
		recordMetadata: { source: 'validated_assignment_planning_output', assignmentId: assignment.id },
	});
}
