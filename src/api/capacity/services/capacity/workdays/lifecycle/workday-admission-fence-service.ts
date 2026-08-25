import { MAX_CAPACITY_PAGE_LIMIT } from '@treeseed/sdk/capacity-pagination';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityGovernanceError } from '../../../../database.ts';
import { logicalModeRunSql } from '../../../../repositories/support/mode-run.ts';
import { assignmentContentIntegrationReadySql,CONTENT_INTEGRATED_EVENT,CONTENT_INTEGRATION_REQUIRED_EVENT } from '../../assignments/lifecycle/assignment-content-integration-requirement.ts';

interface WorkdayAdmissionFenceStore extends CapacityGovernanceDatabase {
	closeCapacityWorkdayAdmission(teamId: string, runId: string): Promise<{ closed: number }>;
}

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
	const run = await store.first(
		`SELECT id,status FROM capacity_workday_runs WHERE id = ? AND team_id = ? LIMIT 1`,
		[runId,teamId],
	);
	if (!run) throw new CapacityGovernanceError('capacity_workday_run_not_found','Capacity workday run does not exist.',404,{ runId });
	const closure = await store.closeCapacityWorkdayAdmission(teamId,runId);
	const envelope = await store.first(
		 `SELECT COUNT(*) AS total,
			COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END),0) AS active
		 FROM workday_capacity_envelopes WHERE team_id = ? AND workday_run_id = ?`,
		[teamId,runId],
	);
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
		 WHERE assignment.team_id = ? AND EXISTS (
			SELECT 1 FROM capacity_workday_demands demand
			 WHERE demand.assignment_id = assignment.id AND demand.workday_run_id = ?
		 )`,
		[teamId,runId],
	);
	const modeRun = await store.first(
		`SELECT COUNT(*) AS total,
			COALESCE(SUM(CASE WHEN mode_run.status = 'failed' THEN 1 ELSE 0 END),0) AS failed,
			COALESCE(SUM(CASE WHEN mode_run.status NOT IN ('succeeded','failed','cancelled') THEN 1 ELSE 0 END),0) AS non_terminal
		 FROM agent_mode_runs mode_run
		 JOIN capacity_provider_assignments assignment ON assignment.id = mode_run.provider_assignment_id
		 WHERE assignment.team_id = ? AND EXISTS (
			SELECT 1 FROM capacity_workday_demands demand
			 WHERE demand.assignment_id = assignment.id AND demand.workday_run_id = ?
		 ) AND ${logicalModeRunSql('mode_run')}`,
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
		 WHERE assignment.team_id = ? AND EXISTS (
			SELECT 1 FROM capacity_workday_demands demand
			 WHERE demand.assignment_id = assignment.id AND demand.workday_run_id = ?
		 )
		   AND (assignment.status <> 'completed'
		     OR NOT (${assignmentContentIntegrationReadySql()})
		     OR (assignment.reservation_id IS NOT NULL AND settlement.assignment_id IS NULL))
		 ORDER BY assignment.created_at ASC,assignment.id ASC LIMIT ?`,
		[teamId,runId,Math.min(20,MAX_CAPACITY_PAGE_LIMIT)],
	);
	const activeEnvelopes = count(envelope,'active');
	const nonTerminalAssignments = count(assignment,'non_terminal');
	const unsettledAssignments = count(assignment,'unsettled');
	const nonTerminalModeRuns = count(modeRun,'non_terminal');
	const failedAssignments = count(assignment,'failed');
	const failedModeRuns = count(modeRun,'failed');
	return {
		schemaVersion: 'treeseed.capacity-workday-admission-fence/v1' as const,
		teamId,runId,closedEnvelopes: closure.closed,
		envelopes: { total: count(envelope,'total'), active: activeEnvelopes },
		assignments: {
			total: count(assignment,'total'), completed: count(assignment,'completed'), failed: failedAssignments,
			nonTerminal: nonTerminalAssignments, unsettled: unsettledAssignments,
		},
		modeRuns: { total: count(modeRun,'total'), failed: failedModeRuns, nonTerminal: nonTerminalModeRuns },
		ready: activeEnvelopes === 0 && nonTerminalAssignments === 0 && unsettledAssignments === 0 && nonTerminalModeRuns === 0,
		successful: failedAssignments === 0,
		problemAssignmentIds: ids(samples),
	};
}
