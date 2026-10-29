import { emptyCapacityBudget, type AssignmentAttempt, type AssignmentResult } from '@treeseed/sdk/agent-capacity';

/** Controlled persistence input shared by the cheap serializer check and native
 * PostgreSQL case. This is not provider admission, measured usage or settlement. */
export function completedPlanningRow(attempt: AssignmentAttempt, result: AssignmentResult, agentId: string) {
	return { id: attempt.id, membership_id: 'controlled-member', team_id: attempt.teamId, project_id: attempt.projectId,
		capacity_provider_id: attempt.provider.providerId, project_agent_class_id: attempt.agentClass, mode: 'planning',
		execution_provider_id: attempt.provider.executionProviderId, work_day_id: attempt.workdayId,
		reservation_id: attempt.reservationId, execution_node_id: attempt.nodeId, execution_node_revision: attempt.nodeRevision,
		graph_revision: attempt.graphRevision, attempt_count: attempt.attempt, state_version: 1,
		execution_kind: 'workday', trigger_kind: 'manual', lease_state: 'released',
		capacity_envelope_json: JSON.stringify({ teamId: attempt.teamId, projectId: attempt.projectId, mode: 'planning',
			workDayId: attempt.workdayId, projectAgentClassId: attempt.agentClass, capacityProviderId: attempt.provider.providerId,
			executionProviderId: attempt.provider.executionProviderId, reservationId: attempt.reservationId,
			budget: emptyCapacityBudget(attempt.deadline, attempt.limits.maximumSeconds) }),
		status: 'completed', agent_id: agentId, completed_at: result.completedAt, assignment_attempt_json: JSON.stringify(attempt),
		assignment_result_json: JSON.stringify(result), created_at: attempt.createdAt, updated_at: attempt.createdAt };
}
