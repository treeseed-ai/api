import type { CapacityWorkdayEventRecord, CapacityWorkdayRunRecord, CapacityWorkdayRunStatus } from '@treeseed/sdk/agent-capacity';
import { MAX_CAPACITY_PAGE_LIMIT } from '@treeseed/sdk/capacity-pagination';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityWorkdayRecoveryRepository } from '../../../../repositories/capacity/workdays/workday-recovery.ts';
import type { WorkdayAssignmentTerminalizationResult } from './workday-assignment-terminalization-service.ts';

type JsonRecord = Record<string, unknown>;
interface WorkdayRecoveryStore extends CapacityGovernanceDatabase {
	terminalizeCapacityWorkdayAssignments(teamId: string, runId: string, input: JsonRecord): Promise<WorkdayAssignmentTerminalizationResult>;
	terminalizeCapacityWorkdayEnvelopes(teamId: string, runId: string, status: string): Promise<{ terminalized: number }>;
	closeCapacityWorkdayAdmission(teamId: string, runId: string): Promise<{ closed: number }>;
	createCapacityWorkdayEvent(teamId: string, runId: string, input: JsonRecord): Promise<CapacityWorkdayEventRecord | null>;
}

function deadline(run: CapacityWorkdayRunRecord) {
	const configured = typeof run.parameters.deadlineAt === 'string' ? run.parameters.deadlineAt : '';
	const deadlineMs = Date.parse(configured);
	const settlementGraceSeconds = Math.max(300, Number(run.parameters.settlementGraceSeconds ?? run.parameters.waitSeconds ?? 0) || 0);
	return { deadlineAt: configured, deadlineMs, settlementGraceSeconds, staleAtMs: deadlineMs + settlementGraceSeconds * 1000 };
}
function terminalEnvelopeStatus(status: CapacityWorkdayRunStatus) { return status === 'cancelled' ? 'cancelled' : status === 'completed' ? 'completed' : status === 'degraded' ? 'degraded' : 'failed'; }
function terminalGraceUntil(run: CapacityWorkdayRunRecord) {
	const seconds = Math.max(300, Number(run.parameters.settlementGraceSeconds ?? run.parameters.waitSeconds ?? 0) || 0);
	const start = Date.parse(run.completedAt ?? new Date().toISOString());
	return new Date(start + seconds * 1000).toISOString();
}
function eventInput(run: CapacityWorkdayRunRecord, actual: JsonRecord): JsonRecord {
	const completed = run.status === 'completed' || actual.terminalStatus === 'completed';
	return { id: `workday-deadline:${run.id}`, eventType: 'workday.deadline_terminalized', status: completed ? 'completed' : 'warning',
		title: completed ? 'Timed workday completed' : 'Timed workday closed with degraded evidence', context: actual };
}

export async function maintainCapacityWorkdayRuns(store: WorkdayRecoveryStore, teamId: string | null = null, now = new Date().toISOString()) {
	const repository = new CapacityWorkdayRecoveryRepository(store); const nowMs = Date.parse(now); let expired = 0; let cursor = '';
	while (true) {
		const runs = await repository.listRunning(teamId, cursor);
		for (const run of runs) {
			const timing = deadline(run); if (!Number.isFinite(timing.deadlineMs) || timing.deadlineMs > nowMs) continue;
			const admissionClosure = await store.closeCapacityWorkdayAdmission(run.teamId, run.id);
			await store.createCapacityWorkdayEvent(run.teamId, run.id, {
				id: `workday-deadline-admission:${run.id}`, eventType: 'workday.deadline_admission_closed', status: 'warning',
				title: 'Workday deadline stopped new assignment admission',
				context: { deadlineAt: timing.deadlineAt, settlementGraceSeconds: timing.settlementGraceSeconds, closedEnvelopes: admissionClosure.closed },
			});
			if (timing.staleAtMs > nowMs) continue;
			const terminalization = await store.terminalizeCapacityWorkdayAssignments(run.teamId, run.id, { now, settlementKeyPrefix: 'workday-deadline', source: 'capacity_workday_deadline_terminalization',
				code: 'workday_deadline_elapsed', reason: 'Workday deadline elapsed before this assignment reached a terminal state.',
				preserveActiveLeasesUntil: new Date(timing.staleAtMs).toISOString(),
				metadata: { deadlineAt: timing.deadlineAt, deadlineSource: 'configured', settlementGraceSeconds: timing.settlementGraceSeconds, expiredAt: now } });
			const evidence = await repository.modeRunEvidence(run.teamId, run.id);
			const terminalStatus = terminalization.assignmentCount > 0 && terminalization.unfinishedAssignmentCount === 0 && terminalization.failedAssignments === 0
				&& evidence.failedModeRuns === 0 && evidence.succeededModeRuns > 0 && evidence.contentArtifactCount > 0 && terminalization.settlementErrorCount === 0 ? 'completed' : 'degraded';
			const actual = { assignmentCount: terminalization.assignmentCount, completedAssignments: terminalization.completedAssignments,
				failedAssignments: terminalization.failedAssignments + terminalization.unfinishedAssignmentCount, ...evidence,
				deferredActiveAssignmentCount: terminalization.deferredActiveAssignmentCount,
				settlementErrors: terminalization.settlementErrors, settlementErrorCount: terminalization.settlementErrorCount,
				settlementErrorsTruncated: terminalization.settlementErrorsTruncated, terminalStatus, deadlineAt: timing.deadlineAt,
				deadlineSource: 'configured', settlementGraceSeconds: timing.settlementGraceSeconds, expiredAt: now, deadlineTerminalizedAt: now };
			const won = await repository.completeDeadline(run, terminalStatus,
				{ status: terminalStatus, message: terminalStatus === 'completed' ? 'Timed workday completed within its governed deadline.' : 'Timed workday closed with incomplete or failed evidence.', ...actual },
				{ status: terminalStatus, assignmentCompletionPercent: terminalization.assignmentCount ? Math.round((terminalization.completedAssignments / terminalization.assignmentCount) * 100) : 0,
					modeRunSuccessPercent: evidence.modeRunCount ? Math.round((evidence.succeededModeRuns / evidence.modeRunCount) * 100) : 0, contentArtifactCount: evidence.contentArtifactCount },
				actual, terminalStatus === 'completed' ? {} : { code: 'workday_deadline_degraded', message: 'Timed workday deadline elapsed without complete successful assignment, content, and settlement evidence.',
					deadlineAt: timing.deadlineAt, deadlineSource: 'configured', settlementGraceSeconds: timing.settlementGraceSeconds, expiredAt: now }, now);
			if (!won) continue;
			await store.terminalizeCapacityWorkdayEnvelopes(run.teamId, run.id, terminalStatus);
			await store.createCapacityWorkdayEvent(run.teamId, run.id, eventInput({ ...run, status: terminalStatus }, actual)); expired += 1;
		}
		if (runs.length === 0 || runs.length < MAX_CAPACITY_PAGE_LIMIT) break;
		cursor = runs.at(-1)!.id;
	}
	let recoveredTerminalRuns = 0; let terminalCursor = '';
	while (true) {
		const terminalRuns = await repository.listTerminal(teamId, terminalCursor); if (!terminalRuns.length) break;
		for (const terminalRun of terminalRuns) {
			const candidate = await repository.recoveryState(terminalRun);
			if (!candidate.hasUnfinishedAssignments && !candidate.hasOpenEnvelopes && !candidate.missingDeadlineEvent) continue;
			const { run } = candidate;
			const terminalization = await store.terminalizeCapacityWorkdayAssignments(run.teamId, run.id, { now, settlementKeyPrefix: 'workday-terminal-recovery', source: 'capacity_workday_terminal_recovery',
				code: `workday_${run.status}_recovered`, reason: `Recovered unfinished assignment state from terminal workday ${run.id}.`,
				preserveActiveLeasesUntil: terminalGraceUntil(run), metadata: { status: run.status, recovery: true } });
			await store.terminalizeCapacityWorkdayEnvelopes(run.teamId, run.id, terminalEnvelopeStatus(run.status));
			if (candidate.missingDeadlineEvent) await store.createCapacityWorkdayEvent(run.teamId, run.id, eventInput(run, run.actual));
			if (candidate.hasUnfinishedAssignments || candidate.hasOpenEnvelopes || candidate.missingDeadlineEvent || terminalization.unfinishedAssignmentCount > 0) recoveredTerminalRuns += 1;
		}
		if (terminalRuns.length < MAX_CAPACITY_PAGE_LIMIT) break;
		terminalCursor = terminalRuns.at(-1)!.id;
	}
	return { expired, recoveredTerminalRuns };
}
