import { createHash } from 'node:crypto';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityGovernanceError } from '../../../../database.ts';
import { CapacityWorkdayEventService } from '../content/workday-event-service.ts';

export interface CapacityWorkdayMaintenanceStore extends CapacityGovernanceDatabase {
	tickCapacityWorkdayRun(teamId: string, runId: string, now?: string, idempotencyKey?: string): Promise<unknown>;
	maintainCapacityWorkdayRuns(teamId?: string | null, now?: string): Promise<{ expired: number; recoveredTerminalRuns?: number }>;
	maintainCapacityRuntimeRetention(now?: string): Promise<{
		expiredAccessTokens: number;
		expiredAvailabilitySessions: number;
		expiredRegistrationRequests: number;
		deletedProofNonces: number;
		deletedRateLimitBuckets: number;
	}>;
	recoverExpiredProviderAssignments(input?: { teamId?: string | null; providerId?: string | null; now?: string; limit?: number }): Promise<{ recovered: number; safeRetries: number; terminalFailures: number; completed: number; operatorActions: number }>;
	tickDueCapacityWorkdaySchedules(now?: string): Promise<{ considered: number; created: number; failures: Record<string, unknown>[] }>;
}

export interface CapacityWorkdayMaintenanceResult {
	ranAt: string;
	terminalizedWorkdays: number;
	recoveredTerminalWorkdays: number;
	recoveredExpiredAssignments: number;
	expiredAssignmentSafeRetries: number;
	expiredAssignmentTerminalFailures: number;
	expiredAssignmentCompletions: number;
	expiredAssignmentOperatorActions: number;
	expiredAccessTokens: number;
	expiredAvailabilitySessions: number;
	expiredRegistrationRequests: number;
	deletedProofNonces: number;
	deletedRateLimitBuckets: number;
	schedulesConsidered: number;
	scheduledWorkdaysCreated: number;
	scheduleTickFailures: number;
	runningWorkdaysConsidered: number;
	runningWorkdaysReticked: number;
	runningWorkdayTickFailures: number;
}

async function retickRunningWorkdays(store: CapacityWorkdayMaintenanceStore, now: string) {
	const rows = await store.all(`SELECT id, team_id FROM capacity_workday_runs
		WHERE status = 'running' ORDER BY created_at ASC, id ASC LIMIT 200`);
	let reticked = 0; let failures = 0;
	for (const row of rows) {
		const runId = String(row.id ?? ''); const teamId = String(row.team_id ?? '');
		if (!runId || !teamId) { failures += 1; continue; }
		try {
			await store.tickCapacityWorkdayRun(teamId,runId,now,`maintenance-recovery:${runId}:${now}`);
			reticked += 1;
		} catch (error) {
			failures += 1;
			const code = error instanceof CapacityGovernanceError ? error.code : 'capacity_workday_tick_failed';
			const message = error instanceof Error ? error.message : String(error);
			const id = `workday_tick_failed_${createHash('sha256').update(`${runId}:${now}:${code}`).digest('base64url').slice(0, 32)}`;
			await new CapacityWorkdayEventService(store).create(teamId, runId, {
				id, eventType: 'workday.tick.failed', status: 'failed', title: 'Workday graph promotion failed', message,
				context: { code, ...(error instanceof CapacityGovernanceError ? { details: error.details } : {}) },
				metadata: { source: 'capacity-workday-maintenance', redactionStatus: 'sanitized' }, createdAt: now,
			}).catch((eventError: unknown) => console.error(JSON.stringify({ ok: false, event: 'workday.tick.failure.unrecorded', runId, code, message, eventError: eventError instanceof Error ? eventError.message : String(eventError) })));
		}
	}
	return { considered:rows.length,reticked,failures };
}

export async function runCapacityWorkdayMaintenance(
	store: CapacityWorkdayMaintenanceStore,
	now = new Date().toISOString(),
): Promise<CapacityWorkdayMaintenanceResult> {
	const [workdays, assignments, retention, schedules] = await Promise.all([
		store.maintainCapacityWorkdayRuns(null, now),
		store.recoverExpiredProviderAssignments({ now, limit: 200 }),
		store.maintainCapacityRuntimeRetention(now),
		store.tickDueCapacityWorkdaySchedules(now),
	]);
	const running = await retickRunningWorkdays(store,now);
	return {
		ranAt: now,
		terminalizedWorkdays: workdays.expired + (workdays.recoveredTerminalRuns ?? 0),
		recoveredTerminalWorkdays: workdays.recoveredTerminalRuns ?? 0,
		recoveredExpiredAssignments: assignments.recovered,
		expiredAssignmentSafeRetries: assignments.safeRetries,
		expiredAssignmentTerminalFailures: assignments.terminalFailures,
		expiredAssignmentCompletions: assignments.completed,
		expiredAssignmentOperatorActions: assignments.operatorActions,
		...retention,
		schedulesConsidered: schedules.considered,
		scheduledWorkdaysCreated: schedules.created,
		scheduleTickFailures: schedules.failures.length,
		runningWorkdaysConsidered: running.considered,
		runningWorkdaysReticked: running.reticked,
		runningWorkdayTickFailures: running.failures,
	};
}

export class CapacityWorkdayMaintenanceScheduler {
	private nextRunAt = 0;
	private running: Promise<CapacityWorkdayMaintenanceResult | null> | null = null;

	constructor(
		private readonly store: CapacityWorkdayMaintenanceStore,
		private readonly intervalMs = 30_000,
	) {
		if (!Number.isFinite(intervalMs) || intervalMs < 1_000) {
			throw new Error('Capacity workday maintenance interval must be at least 1000ms.');
		}
	}

	runIfDue(now = new Date()): Promise<CapacityWorkdayMaintenanceResult | null> {
		if (this.running) return this.running;
		if (now.getTime() < this.nextRunAt) return Promise.resolve(null);
		this.nextRunAt = now.getTime() + this.intervalMs;
		this.running = runCapacityWorkdayMaintenance(this.store, now.toISOString())
			.finally(() => {
				this.running = null;
			});
		return this.running;
	}
}
