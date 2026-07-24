import { MAX_CAPACITY_PAGE_LIMIT } from '@treeseed/sdk/capacity-pagination';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityGovernanceError } from '../../../../database.ts';
import { releaseCapacityReservationsExactlyOnce } from '../../accounting/settlement-service.ts';

interface TerminalAssignmentRow extends Record<string, unknown> {
	id: string;
	membership_id: string | null;
	reservation_id: string | null;
	state_version: number | string | null;
}

interface AssignmentTotalsRow extends Record<string, unknown> {
	assignment_count?: number | string | null;
	completed_assignments?: number | string | null;
	failed_assignments?: number | string | null;
	unfinished_assignments?: number | string | null;
}

export interface WorkdayAssignmentTerminalizationInput {
	now?: string;
	preserveActiveLeasesUntil?: string | null;
	settlementKeyPrefix?: string;
	source?: string;
	code?: string;
	reason?: string;
	metadata?: Record<string, unknown>;
}

export interface WorkdayAssignmentTerminalizationResult {
	assignmentCount: number;
	completedAssignments: number;
	failedAssignments: number;
	unfinishedAssignmentCount: number;
	deferredActiveAssignmentCount: number;
	settlementErrors: [];
	settlementErrorCount: 0;
	settlementErrorsTruncated: false;
}

function number(value: unknown): number {
	const parsed = Number(value ?? 0);
	return Number.isFinite(parsed) ? parsed : 0;
}

async function settleTerminalAssignments(
	database: CapacityGovernanceDatabase,
	assignments: TerminalAssignmentRow[],
	teamId: string,
	runId: string,
	now: string,
	input: WorkdayAssignmentTerminalizationInput,
) {
	for (const assignment of assignments) {
		if (!assignment.reservation_id || !assignment.membership_id) {
			throw new CapacityGovernanceError(
				'workday_assignment_admission_provenance_missing',
				`Workday assignment ${assignment.id} cannot be terminalized without reservation and membership provenance.`,
				409,
				{ teamId, runId, assignmentId: assignment.id },
			);
		}
	}
	await releaseCapacityReservationsExactlyOnce(
		database,
		assignments.map((assignment) => ({
				settlementKey: `${input.settlementKeyPrefix ?? 'workday-terminal'}:${runId}:${assignment.id}`,
				teamId,
				membershipId: assignment.membership_id!,
				reservationId: assignment.reservation_id!,
				assignmentId: assignment.id,
				actualCredits: 0,
				source: input.source ?? 'capacity_workday_terminalization',
				existingSettlementPolicy: 'replay',
				metadata: { runId, terminalizedAt: now, ...(input.metadata ?? {}) },
		})),
	);
}

export async function terminalizeCapacityWorkdayAssignments(
	database: CapacityGovernanceDatabase,
	teamId: string,
	runId: string,
	input: WorkdayAssignmentTerminalizationInput = {},
): Promise<WorkdayAssignmentTerminalizationResult> {
	await database.ensureInitialized();
	const now = input.now ?? new Date().toISOString();
	const initialTotals = await database.first<AssignmentTotalsRow>(
		`SELECT COUNT(*) AS assignment_count,
		        COALESCE(SUM(CASE WHEN assignment.status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_assignments,
		        COALESCE(SUM(CASE WHEN assignment.status IN ('failed', 'expired', 'cancelled') THEN 1 ELSE 0 END), 0) AS failed_assignments,
		        COALESCE(SUM(CASE WHEN assignment.status NOT IN ('completed', 'failed', 'expired', 'cancelled') THEN 1 ELSE 0 END), 0) AS unfinished_assignments
		 FROM capacity_provider_assignments assignment
		 JOIN capacity_workday_demands demand ON demand.assignment_id = assignment.id
		 WHERE assignment.team_id = ? AND demand.workday_run_id = ?`,
		[teamId, runId],
	);
	const preserveUntil = input.preserveActiveLeasesUntil && Number.isFinite(Date.parse(input.preserveActiveLeasesUntil))
		? input.preserveActiveLeasesUntil
		: now;

	while (true) {
		const assignments = await database.all<TerminalAssignmentRow>(
			`SELECT assignment.id, assignment.membership_id, assignment.reservation_id, assignment.state_version
			 FROM capacity_provider_assignments assignment
			 JOIN capacity_workday_demands demand ON demand.assignment_id = assignment.id
			 WHERE assignment.team_id = ? AND demand.workday_run_id = ?
			   AND assignment.status NOT IN ('completed', 'failed', 'expired', 'cancelled')
			   AND NOT (? > ? AND assignment.status = 'leased' AND assignment.lease_state = 'leased'
			     AND assignment.lease_token IS NOT NULL AND assignment.lease_expires_at IS NOT NULL AND assignment.lease_expires_at > ?)
			 ORDER BY assignment.created_at ASC, assignment.id ASC
			 LIMIT ?`,
			[teamId, runId, preserveUntil, now, now, MAX_CAPACITY_PAGE_LIMIT],
		);
		if (assignments.length === 0) break;

		await settleTerminalAssignments(database, assignments, teamId, runId, now, input);
		const assignmentsByVersion = new Map<number, TerminalAssignmentRow[]>();
		for (const assignment of assignments) {
			const version = number(assignment.state_version);
			const versionAssignments = assignmentsByVersion.get(version) ?? [];
			versionAssignments.push(assignment);
			assignmentsByVersion.set(version, versionAssignments);
		}
		const stateOperations = [...assignmentsByVersion.entries()].flatMap(([stateVersion, versionAssignments]) => {
			const ids = versionAssignments.map(() => '?').join(', ');
			const idValues = versionAssignments.map((assignment) => assignment.id);
			return [{
				query: `UPDATE agent_mode_runs
				 SET status = 'failed',
				     fallback_reason = COALESCE(fallback_reason, ?),
				     failed_at = COALESCE(failed_at, ?),
				     updated_at = ?
				 WHERE team_id = ? AND status IN ('queued', 'running')
				   AND provider_assignment_id IN (
				     SELECT id FROM capacity_provider_assignments
				      WHERE team_id = ? AND state_version = ? AND id IN (${ids})
				        AND status NOT IN ('completed', 'failed', 'expired', 'cancelled')
				   )`,
				params: [input.reason ?? 'Workday terminalized before the mode run completed.', now, now, teamId, teamId, stateVersion, ...idValues],
			},
			{
				query: `UPDATE capacity_provider_assignments
				 SET status = 'failed',
				     lease_state = 'released',
				     lease_token = NULL,
				     lease_expires_at = NULL,
				     lease_renewed_at = NULL,
				     runner_id = NULL,
				     failed_at = COALESCE(failed_at, ?),
				     lifecycle_reason = ?,
				     lifecycle_code = ?,
				     lifecycle_output_json = ?,
				     state_version = state_version + 1,
				     updated_at = ?
				 WHERE team_id = ? AND state_version = ? AND id IN (${ids})
				   AND status NOT IN ('completed', 'failed', 'expired', 'cancelled')`,
				params: [
					now,
					input.reason ?? 'Workday terminalized before this assignment reached a terminal state.',
					input.code ?? 'workday_terminalized',
					JSON.stringify({ runId, terminalizedAt: now, ...(input.metadata ?? {}) }),
					now,
					teamId,
					stateVersion,
					...idValues,
				],
			},
			{
				query: `UPDATE capacity_workday_demands SET status = 'blocked', completed_at = ?, updated_at = ?
				 WHERE assignment_id IN (${ids}) AND status = 'admitted'
				   AND assignment_id IN (SELECT id FROM capacity_provider_assignments WHERE status = 'failed' AND id IN (${ids}))`,
				params: [now, now, ...idValues, ...idValues],
			},
			{
				query: `UPDATE capacity_workday_participation_entries SET status = 'blocked', reason_code = ?, covered_at = ?, updated_at = ?
				 WHERE assignment_id IN (${ids}) AND status = 'assigned'
				   AND assignment_id IN (SELECT id FROM capacity_provider_assignments WHERE status = 'failed' AND id IN (${ids}))`,
				params: [input.code ?? 'workday_terminalized', now, now, ...idValues, ...idValues],
			},
			];
		});
		await database.batch(stateOperations);
		if (assignments.length < MAX_CAPACITY_PAGE_LIMIT) break;
	}
	const finalTotals = await database.first<AssignmentTotalsRow>(
		`SELECT COUNT(*) AS assignment_count,
		        COALESCE(SUM(CASE WHEN assignment.status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_assignments,
		        COALESCE(SUM(CASE WHEN assignment.status IN ('failed', 'expired', 'cancelled') THEN 1 ELSE 0 END), 0) AS failed_assignments,
		        COALESCE(SUM(CASE WHEN assignment.status NOT IN ('completed', 'failed', 'expired', 'cancelled') THEN 1 ELSE 0 END), 0) AS unfinished_assignments
		 FROM capacity_provider_assignments assignment
		 JOIN capacity_workday_demands demand ON demand.assignment_id = assignment.id
		 WHERE assignment.team_id = ? AND demand.workday_run_id = ?`, [teamId, runId],
	);
	const deferred = await database.first<{ total?: unknown }>(
		`SELECT COUNT(*) AS total FROM capacity_provider_assignments assignment
		 JOIN capacity_workday_demands demand ON demand.assignment_id = assignment.id
		 WHERE assignment.team_id = ? AND demand.workday_run_id = ? AND assignment.status = 'leased' AND assignment.lease_state = 'leased'
		   AND assignment.lease_token IS NOT NULL AND assignment.lease_expires_at IS NOT NULL AND assignment.lease_expires_at > ?
		   AND ? > ?`, [teamId, runId, now, preserveUntil, now],
	);

	return {
		assignmentCount: number(finalTotals?.assignment_count ?? initialTotals?.assignment_count),
		completedAssignments: number(finalTotals?.completed_assignments),
		failedAssignments: number(finalTotals?.failed_assignments),
		unfinishedAssignmentCount: number(finalTotals?.unfinished_assignments),
		deferredActiveAssignmentCount: number(deferred?.total),
		settlementErrors: [],
		settlementErrorCount: 0,
		settlementErrorsTruncated: false,
	};
}
