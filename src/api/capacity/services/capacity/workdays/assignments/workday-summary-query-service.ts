import {
normalizeCapacityPageLimit,
type CapacityPageCursor,
} from '@treeseed/sdk/capacity-pagination';
import { logicalModeRunSql } from '../../../../repositories/support/mode-run.ts';

interface WorkdaySummaryDatabase {
	first(query: string, values?: unknown[]): Promise<Record<string, unknown> | null>;
	all(query: string, values?: unknown[]): Promise<Array<Record<string, unknown>>>;
}

export interface EvidencePage {
	items: Array<Record<string, unknown>>;
	page: { limit: number; hasMore: boolean; nextCursor: string | null };
}

export interface WorkdaySummaryEnvelope extends Record<string, unknown> {
	id: string;
	teamId: string;
	projectId: string;
	allocationSetId?: string | null;
}

interface WorkdaySummaryRepository extends WorkdaySummaryDatabase {
	getWorkdayCapacityEnvelope(workdayId: string): Promise<WorkdaySummaryEnvelope | null>;
	listProviderAssignmentsPage(teamId: string, filters: Record<string, unknown>): Promise<EvidencePage>;
	listAgentModeRunsPage(projectId: string, filters: Record<string, unknown>): Promise<EvidencePage>;
	listCapacityReservationsForProjectPage(projectId: string, filters: Record<string, unknown>): Promise<EvidencePage>;
	listTaskUsageActualsPage(projectId: string, filters: Record<string, unknown>): Promise<EvidencePage>;
	listCapacityLedgerEntriesPage(projectId: string, filters: Record<string, unknown>): Promise<EvidencePage>;
}

export interface WorkdaySummaryOptions {
	evidence?: 'assignments' | 'mode-runs' | 'reservations' | 'usage-actuals' | 'ledger-entries' | null;
	limit?: number | null;
	cursor?: CapacityPageCursor | null;
}

export interface WorkdaySummaryAggregate {
	assignment: {
		total: number;
		pending: number;
		leased: number;
		completed: number;
		failed: number;
		returned: number;
		cancelled: number;
		missingSettlementCount: number;
		missingUsageCount: number;
	};
	modeRun: {
		total: number;
		queued: number;
		running: number;
		succeeded: number;
		failed: number;
		usageReported: number;
	};
	reservation: { total: number; requestedSeconds: number; reservedSeconds: number; activeSeconds: number; elapsedSeconds: number; releasedSeconds: number; overrunSeconds: number };
	usage: {
		total: number;
		assignmentTotal: number;
		inputTokens: number;
		outputTokens: number;
		cachedInputTokens: number;
		reasoningTokens: number;
		quotaMinutes: number;
		wallMinutes: number;
		activeSeconds: number;
		elapsedSeconds: number;
		actualUsd: number;
	};
	ledger: { total: number; activeSeconds: number; elapsedSeconds: number };
	warningSamples: {
		missingSettlementAssignmentIds: string[];
		missingUsageAssignmentIds: string[];
	};
}

function count(row: Record<string, unknown> | null, key: string): number {
	return Number(row?.[key] ?? 0);
}

function rowIds(rows: Array<Record<string, unknown>>): string[] {
	return rows.map((row) => String(row.id ?? '')).filter(Boolean);
}

export async function aggregateWorkdaySummary(
	database: WorkdaySummaryDatabase,
	input: { workDayId: string; warningSampleLimit?: number },
): Promise<WorkdaySummaryAggregate> {
	const assignmentScope = `FROM capacity_provider_assignments assignment WHERE assignment.work_day_id = ?`;
	const [assignment, missingSettlement, missingUsage, modeRun, reservation, usage, ledger] = await Promise.all([
		database.first(
			`SELECT COUNT(*) AS total,
				COALESCE(SUM(CASE WHEN assignment.status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
				COALESCE(SUM(CASE WHEN assignment.status = 'leased' THEN 1 ELSE 0 END), 0) AS leased,
				COALESCE(SUM(CASE WHEN assignment.status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
				COALESCE(SUM(CASE WHEN assignment.status IN ('failed', 'expired') THEN 1 ELSE 0 END), 0) AS failed,
				COALESCE(SUM(CASE WHEN assignment.status = 'returned' THEN 1 ELSE 0 END), 0) AS returned,
				COALESCE(SUM(CASE WHEN assignment.status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled
			 ${assignmentScope}`,
			[input.workDayId],
		),
		database.first(
			`SELECT COUNT(*) AS total FROM capacity_provider_assignments assignment
			 LEFT JOIN (
				SELECT DISTINCT assignment_id FROM capacity_ledger_entries
				 WHERE phase = 'task_completed_actual_settlement'
			 ) settled ON settled.assignment_id = assignment.id
			 WHERE assignment.work_day_id = ? AND assignment.status = 'completed'
			   AND assignment.reservation_id IS NOT NULL AND settled.assignment_id IS NULL`,
			[input.workDayId],
		),
		database.first(
			`SELECT COUNT(*) AS total FROM capacity_provider_assignments assignment
			 LEFT JOIN (SELECT DISTINCT assignment_id FROM capacity_usage_actuals) task_usage
			   ON task_usage.assignment_id = assignment.id
			 LEFT JOIN (
				SELECT DISTINCT provider_assignment_id FROM agent_mode_runs
				 WHERE usage_actual_json IS NOT NULL AND usage_actual_json <> '{}' AND ${logicalModeRunSql()}
			 ) mode_usage ON mode_usage.provider_assignment_id = assignment.id
			 WHERE assignment.work_day_id = ? AND assignment.status = 'completed'
			   AND task_usage.assignment_id IS NULL AND mode_usage.provider_assignment_id IS NULL`,
			[input.workDayId],
		),
		database.first(
			`SELECT COUNT(*) AS total,
				COALESCE(SUM(CASE WHEN mode_run.status = 'queued' THEN 1 ELSE 0 END), 0) AS queued,
				COALESCE(SUM(CASE WHEN mode_run.status = 'running' THEN 1 ELSE 0 END), 0) AS running,
				COALESCE(SUM(CASE WHEN mode_run.status = 'succeeded' THEN 1 ELSE 0 END), 0) AS succeeded,
				COALESCE(SUM(CASE WHEN mode_run.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
				COALESCE(SUM(CASE WHEN mode_run.usage_actual_json IS NOT NULL AND mode_run.usage_actual_json <> '{}' THEN 1 ELSE 0 END), 0) AS usage_reported
			 FROM agent_mode_runs mode_run
			 JOIN capacity_provider_assignments assignment ON assignment.id = mode_run.provider_assignment_id
			 WHERE assignment.work_day_id = ? AND ${logicalModeRunSql('mode_run')}`,
			[input.workDayId],
		),
		database.first(
			`SELECT COUNT(*) AS total,
				COALESCE(SUM(reservation.requested_seconds), 0) AS requested_seconds,
				COALESCE(SUM(reservation.reserved_seconds), 0) AS reserved_seconds,
				COALESCE(SUM(reservation.active_seconds), 0) AS active_seconds,
				COALESCE(SUM(reservation.elapsed_seconds), 0) AS elapsed_seconds,
				COALESCE(SUM(reservation.released_seconds), 0) AS released_seconds,
				COALESCE(SUM(reservation.overrun_seconds), 0) AS overrun_seconds
			 FROM capacity_reservations reservation
			 WHERE reservation.work_day_id = ?`,
			[input.workDayId],
		),
		database.first(
			`SELECT COUNT(*) AS total,
				COUNT(DISTINCT usage.assignment_id) AS assignment_total,
				COALESCE(SUM(CASE WHEN usage.usage_dimension = 'aggregate' OR aggregate_usage.assignment_id IS NULL THEN usage.input_tokens ELSE 0 END), 0) AS input_tokens,
				COALESCE(SUM(CASE WHEN usage.usage_dimension = 'aggregate' OR aggregate_usage.assignment_id IS NULL THEN usage.output_tokens ELSE 0 END), 0) AS output_tokens,
				COALESCE(SUM(CASE WHEN usage.usage_dimension = 'aggregate' OR aggregate_usage.assignment_id IS NULL THEN usage.cached_input_tokens ELSE 0 END), 0) AS cached_input_tokens,
				COALESCE(SUM(CASE WHEN usage.usage_dimension = 'aggregate' OR aggregate_usage.assignment_id IS NULL THEN usage.reasoning_tokens ELSE 0 END), 0) AS reasoning_tokens,
				COALESCE(SUM(CASE WHEN usage.usage_dimension = 'aggregate' OR aggregate_usage.assignment_id IS NULL THEN usage.quota_minutes ELSE 0 END), 0) AS quota_minutes,
				COALESCE(SUM(CASE WHEN usage.usage_dimension = 'aggregate' OR aggregate_usage.assignment_id IS NULL THEN usage.wall_minutes ELSE 0 END), 0) AS wall_minutes,
				COALESCE(SUM(CASE WHEN usage.accounting_mode = 'aggregate' OR aggregate_usage.assignment_id IS NULL AND usage.accounting_mode = 'incremental' THEN usage.active_seconds ELSE 0 END), 0) AS active_seconds,
				COALESCE(SUM(CASE WHEN usage.accounting_mode = 'aggregate' OR aggregate_usage.assignment_id IS NULL AND usage.accounting_mode = 'incremental' THEN usage.elapsed_seconds ELSE 0 END), 0) AS elapsed_seconds,
				COALESCE(SUM(CASE WHEN usage.accounting_mode = 'aggregate' OR aggregate_usage.assignment_id IS NULL AND usage.accounting_mode = 'incremental' THEN usage.actual_usd ELSE 0 END), 0) AS actual_usd
			 FROM capacity_usage_actuals usage
			 LEFT JOIN (SELECT assignment_id, assignment_attempt FROM capacity_usage_actuals WHERE usage_dimension = 'aggregate' GROUP BY assignment_id, assignment_attempt) aggregate_usage
			   ON aggregate_usage.assignment_id = usage.assignment_id AND aggregate_usage.assignment_attempt = usage.assignment_attempt
			 WHERE usage.work_day_id = ?`,
			[input.workDayId],
		),
		database.first(
			`SELECT COUNT(*) AS total,
				COALESCE(SUM(CASE WHEN phase = 'task_completed_actual_settlement' THEN active_seconds ELSE 0 END), 0) AS active_seconds,
				COALESCE(SUM(CASE WHEN phase = 'task_completed_actual_settlement' THEN elapsed_seconds ELSE 0 END), 0) AS elapsed_seconds
			 FROM capacity_ledger_entries
			 WHERE work_day_id = ?`,
			[input.workDayId],
		),
	]);
	const sampleLimit = Math.max(1, Math.min(Number(input.warningSampleLimit ?? 20), 100));
	const [missingSettlementRows, missingUsageRows] = await Promise.all([
		database.all(
			`SELECT assignment.id FROM capacity_provider_assignments assignment
			 LEFT JOIN (
				SELECT DISTINCT assignment_id FROM capacity_ledger_entries
				 WHERE phase = 'task_completed_actual_settlement'
			 ) settled ON settled.assignment_id = assignment.id
			 WHERE assignment.work_day_id = ? AND assignment.status = 'completed'
			   AND assignment.reservation_id IS NOT NULL AND settled.assignment_id IS NULL
			 ORDER BY assignment.created_at ASC, assignment.id ASC LIMIT ?`,
			[input.workDayId, sampleLimit],
		),
		database.all(
			`SELECT assignment.id FROM capacity_provider_assignments assignment
			 LEFT JOIN (SELECT DISTINCT assignment_id FROM capacity_usage_actuals) task_usage
			   ON task_usage.assignment_id = assignment.id
			 LEFT JOIN (
				SELECT DISTINCT provider_assignment_id FROM agent_mode_runs
				 WHERE usage_actual_json IS NOT NULL AND usage_actual_json <> '{}' AND ${logicalModeRunSql()}
			 ) mode_usage ON mode_usage.provider_assignment_id = assignment.id
			 WHERE assignment.work_day_id = ? AND assignment.status = 'completed'
			   AND task_usage.assignment_id IS NULL AND mode_usage.provider_assignment_id IS NULL
			 ORDER BY assignment.created_at ASC, assignment.id ASC LIMIT ?`,
			[input.workDayId, sampleLimit],
		),
	]);
	return {
		assignment: {
			total: count(assignment, 'total'), pending: count(assignment, 'pending'), leased: count(assignment, 'leased'),
			completed: count(assignment, 'completed'), failed: count(assignment, 'failed'), returned: count(assignment, 'returned'),
			cancelled: count(assignment, 'cancelled'), missingSettlementCount: count(missingSettlement, 'total'),
			missingUsageCount: count(missingUsage, 'total'),
		},
		modeRun: {
			total: count(modeRun, 'total'), queued: count(modeRun, 'queued'), running: count(modeRun, 'running'),
			succeeded: count(modeRun, 'succeeded'), failed: count(modeRun, 'failed'), usageReported: count(modeRun, 'usage_reported'),
		},
		reservation: { total: count(reservation, 'total'), requestedSeconds: count(reservation, 'requested_seconds'), reservedSeconds: count(reservation, 'reserved_seconds'), activeSeconds: count(reservation, 'active_seconds'), elapsedSeconds: count(reservation, 'elapsed_seconds'), releasedSeconds: count(reservation, 'released_seconds'), overrunSeconds: count(reservation, 'overrun_seconds') },
		usage: {
			total: count(usage, 'total'), assignmentTotal: count(usage, 'assignment_total'), inputTokens: count(usage, 'input_tokens'),
			outputTokens: count(usage, 'output_tokens'), cachedInputTokens: count(usage, 'cached_input_tokens'),
			reasoningTokens: count(usage, 'reasoning_tokens'),
			quotaMinutes: count(usage, 'quota_minutes'), wallMinutes: count(usage, 'wall_minutes'),
			activeSeconds: count(usage, 'active_seconds'), elapsedSeconds: count(usage, 'elapsed_seconds'), actualUsd: count(usage, 'actual_usd'),
		},
		ledger: { total: count(ledger, 'total'), activeSeconds: count(ledger, 'active_seconds'), elapsedSeconds: count(ledger, 'elapsed_seconds') },
		warningSamples: {
			missingSettlementAssignmentIds: rowIds(missingSettlementRows),
			missingUsageAssignmentIds: rowIds(missingUsageRows),
		},
	};
}

export async function buildWorkdayCapacitySummary(
	repository: WorkdaySummaryRepository,
	workdayId: string,
	options: WorkdaySummaryOptions = {},
) {
	const envelope = await repository.getWorkdayCapacityEnvelope(workdayId);
	if (!envelope) return null;
	const selectedEvidence = options.evidence ?? null;
	const aggregate = await aggregateWorkdaySummary(repository, { workDayId: workdayId });
	const evidenceLimit = normalizeCapacityPageLimit(options.limit);
	let evidence: Record<string,unknown> | null = null;
	if (selectedEvidence === 'assignments') evidence = { assignments: { ...await repository.listProviderAssignmentsPage(envelope.teamId, {
			projectId: envelope.projectId,
			workdayId,
			limit: evidenceLimit,
			cursor: options.cursor ?? null,
		}),total: aggregate.assignment.total } };
	if (selectedEvidence === 'mode-runs') evidence = { modeRuns: { ...await repository.listAgentModeRunsPage(envelope.projectId, {
			workDayId: workdayId,
			limit: evidenceLimit,
			cursor: options.cursor ?? null,
		}),total: aggregate.modeRun.total } };
	if (selectedEvidence === 'reservations') evidence = { reservations: { ...await repository.listCapacityReservationsForProjectPage(envelope.projectId, {
			workDayId: workdayId,
			limit: evidenceLimit,
			cursor: options.cursor ?? null,
		}),total: aggregate.reservation.total } };
	if (selectedEvidence === 'usage-actuals') evidence = { usageActuals: { ...await repository.listTaskUsageActualsPage(envelope.projectId, {
			workDayId: workdayId,
			limit: evidenceLimit,
			cursor: options.cursor ?? null,
		}),total: aggregate.usage.total } };
	if (selectedEvidence === 'ledger-entries') evidence = { ledgerEntries: { ...await repository.listCapacityLedgerEntriesPage(envelope.projectId, {
			workDayId: workdayId,
			limit: evidenceLimit,
			cursor: options.cursor ?? null,
		}),total: aggregate.ledger.total } };
	const warnings: string[] = [];
	if (aggregate.assignment.missingSettlementCount > 0) {
		warnings.push(`${aggregate.assignment.missingSettlementCount} completed assignments have no actual-settlement ledger entry; sample: ${aggregate.warningSamples.missingSettlementAssignmentIds.join(', ') || 'unavailable'}`);
	}
	if (aggregate.assignment.missingUsageCount > 0) {
		warnings.push(`${aggregate.assignment.missingUsageCount} completed assignments have no durable native usage; sample: ${aggregate.warningSamples.missingUsageAssignmentIds.join(', ') || 'unavailable'}`);
	}
	if (aggregate.reservation.activeSeconds !== aggregate.ledger.activeSeconds) {
		warnings.push(`reservation active time ${aggregate.reservation.activeSeconds}s does not match settlement ledger active time ${aggregate.ledger.activeSeconds}s`);
	}
	return {
		ok: true as const,
		payload: {
			workday: envelope,
			totals: {
				assignments: {
					total: aggregate.assignment.total,
					pending: aggregate.assignment.pending,
					leased: aggregate.assignment.leased,
					completed: aggregate.assignment.completed,
					failed: aggregate.assignment.failed,
					returned: aggregate.assignment.returned,
					cancelled: aggregate.assignment.cancelled,
				},
				modeRuns: {
					total: aggregate.modeRun.total,
					queued: aggregate.modeRun.queued,
					running: aggregate.modeRun.running,
					succeeded: aggregate.modeRun.succeeded,
					failed: aggregate.modeRun.failed,
					usageReported: aggregate.modeRun.usageReported,
				},
				reservations: aggregate.reservation.total,
				usageActuals: aggregate.usage.total,
				ledgerEntries: aggregate.ledger.total,
			},
			settlement: {
				teamId: envelope.teamId,
				projectId: envelope.projectId,
				workDayId: envelope.id,
				allocationSetId: envelope.allocationSetId ?? null,
				requestedSeconds: aggregate.reservation.requestedSeconds,
				reservedSeconds: aggregate.reservation.reservedSeconds,
				activeSeconds: aggregate.ledger.activeSeconds,
				elapsedSeconds: aggregate.ledger.elapsedSeconds,
				releasedSeconds: aggregate.reservation.releasedSeconds,
				overrunSeconds: aggregate.reservation.overrunSeconds,
				nativeUsage: {
					taskActualCount: aggregate.usage.assignmentTotal,
					modeRunUsageCount: aggregate.modeRun.usageReported,
					inputTokens: aggregate.usage.inputTokens,
					outputTokens: aggregate.usage.outputTokens,
					cachedInputTokens: aggregate.usage.cachedInputTokens,
					reasoningTokens: aggregate.usage.reasoningTokens,
					quotaMinutes: aggregate.usage.quotaMinutes,
					wallMinutes: aggregate.usage.wallMinutes,
					activeSeconds: aggregate.usage.activeSeconds,
					elapsedSeconds: aggregate.usage.elapsedSeconds,
					actualUsd: aggregate.usage.actualUsd,
				},
				providerConfidence: warnings.length ? 'medium' : 'high',
				warnings,
			},
			evidence,
		},
	};
}
