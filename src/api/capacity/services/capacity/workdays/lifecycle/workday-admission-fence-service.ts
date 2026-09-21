import { MAX_CAPACITY_PAGE_LIMIT } from '@treeseed/sdk/capacity-pagination';
import { CapacityGovernanceError } from '../../../../database.ts';
import { assignmentContentIntegrationReadySql,CONTENT_INTEGRATED_EVENT,CONTENT_INTEGRATION_REQUIRED_EVENT } from '../../assignments/lifecycle/assignment-content-integration-requirement.ts';
import { CapacityWorkdayRunRepository } from '../../../../repositories/capacity/workdays/workday-run.ts';
import { advanceLivingWorkday } from './living-workday-lifecycle.ts';
import { reconcileExecutionGraph } from '../../../../../control-plane/repositories/capacity/execution/execution-graph-service.ts';

type WorkdayAdmissionFenceStore = Parameters<typeof advanceLivingWorkday>[0];

function count(row: Record<string, unknown> | null, key: string) {
	return Number(row?.[key] ?? 0);
}

function ids(rows: Array<Record<string, unknown>>) {
	return rows.map((row) => String(row.id ?? '')).filter(Boolean);
}

export async function fenceCapacityWorkdayAdmission(
	store: WorkdayAdmissionFenceStore,
	teamId: string,
	runId: string,
) {
	const run = await new CapacityWorkdayRunRepository(store).get(teamId, runId);
	if (!run) throw new CapacityGovernanceError('capacity_workday_run_not_found','Capacity workday run does not exist.',404,{ runId });
	if (run.status === 'running' && !run.parameters.appliedPlan) throw new CapacityGovernanceError(
		'capacity_workday_plan_missing', 'Running workday has no authoritative applied plan to close.', 409, { runId });
	if (run.status === 'running' && run.parameters.appliedPlan) {
		await advanceLivingWorkday(store, run, new Date().toISOString(), true);
		await reconcileExecutionGraph(store, teamId);
	}
	const assignment = await store.first(
		`SELECT COUNT(*) AS total,
			COALESCE(SUM(CASE WHEN assignment.status = 'completed'
				AND (${assignmentContentIntegrationReadySql()}) THEN 1 ELSE 0 END),0) AS completed,
			COALESCE(SUM(CASE WHEN assignment.status IN ('failed','expired','cancelled') THEN 1 ELSE 0 END),0) AS failed,
			COALESCE(SUM(CASE WHEN assignment.status NOT IN ('completed','failed','expired','cancelled')
				OR (assignment.status = 'completed' AND NOT (${assignmentContentIntegrationReadySql()}))
				THEN 1 ELSE 0 END),0) AS non_terminal,
			COALESCE(SUM(CASE WHEN assignment.reservation_id IS NOT NULL
				AND assignment.status IN ('completed','failed','expired','cancelled')
				AND settlement.assignment_id IS NULL THEN 1 ELSE 0 END),0) AS unsettled
		 FROM capacity_provider_assignments assignment
		 LEFT JOIN (SELECT DISTINCT assignment_id FROM capacity_ledger_entries WHERE phase = 'task_completed_actual_settlement') settlement
		   ON settlement.assignment_id = assignment.id
		 LEFT JOIN (SELECT DISTINCT target_id AS id FROM audit_events
		   WHERE target_type = 'capacity_provider_assignment' AND event_type = '${CONTENT_INTEGRATION_REQUIRED_EVENT}') integration_required
		   ON integration_required.id = assignment.id
		 LEFT JOIN (SELECT DISTINCT target_id AS id FROM audit_events
		   WHERE target_type = 'capacity_provider_assignment' AND event_type = '${CONTENT_INTEGRATED_EVENT}') integrated_assignment
		   ON integrated_assignment.id = assignment.id
		 WHERE assignment.team_id = ? AND assignment.work_day_id = ?`,
		[teamId,runId],
	);
	const samples = await store.all(
		`SELECT assignment.id,assignment.status
		 FROM capacity_provider_assignments assignment
		 LEFT JOIN (SELECT DISTINCT assignment_id FROM capacity_ledger_entries WHERE phase = 'task_completed_actual_settlement') settlement
		   ON settlement.assignment_id = assignment.id
		 LEFT JOIN (SELECT DISTINCT target_id AS id FROM audit_events
		   WHERE target_type = 'capacity_provider_assignment' AND event_type = '${CONTENT_INTEGRATION_REQUIRED_EVENT}') integration_required
		   ON integration_required.id = assignment.id
		 LEFT JOIN (SELECT DISTINCT target_id AS id FROM audit_events
		   WHERE target_type = 'capacity_provider_assignment' AND event_type = '${CONTENT_INTEGRATED_EVENT}') integrated_assignment
		   ON integrated_assignment.id = assignment.id
		 WHERE assignment.team_id = ? AND assignment.work_day_id = ?
		   AND (assignment.status <> 'completed'
		     OR NOT (${assignmentContentIntegrationReadySql()})
		     OR (assignment.reservation_id IS NOT NULL AND settlement.assignment_id IS NULL))
		 ORDER BY assignment.created_at ASC,assignment.id ASC LIMIT ?`,
		[teamId,runId,Math.min(20,MAX_CAPACITY_PAGE_LIMIT)],
	);
	const nonTerminalAssignments = count(assignment,'non_terminal');
	const unsettledAssignments = count(assignment,'unsettled');
	const failedAssignments = count(assignment,'failed');
	return {
		schemaVersion: 'treeseed.capacity-workday-admission-fence/v1' as const,
		teamId,runId,admissionClosed: true,
		assignments: {
			total: count(assignment,'total'), completed: count(assignment,'completed'), failed: failedAssignments,
			nonTerminal: nonTerminalAssignments, unsettled: unsettledAssignments,
		},
		ready: nonTerminalAssignments === 0 && unsettledAssignments === 0,
		successful: failedAssignments === 0,
		problemAssignmentIds: ids(samples),
	};
}
