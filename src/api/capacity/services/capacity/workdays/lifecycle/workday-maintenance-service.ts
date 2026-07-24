export interface CapacityWorkdayMaintenanceStore {
	maintainCapacityWorkdayRuns(teamId?: string | null, now?: string): Promise<{ expired: number; recoveredTerminalRuns?: number }>;
	maintainCapacityRuntimeRetention(now?: string): Promise<{
		expiredAccessTokens: number;
		expiredAvailabilitySessions: number;
		expiredRegistrationRequests: number;
		deletedProofNonces: number;
		deletedRateLimitBuckets: number;
	}>;
	recoverExpiredProviderAssignments(input?: { teamId?: string | null; providerId?: string | null; now?: string; limit?: number }): Promise<{ recovered: number; safeRetries: number; terminalFailures: number; completed: number; operatorActions: number }>;
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
}

export async function runCapacityWorkdayMaintenance(
	store: CapacityWorkdayMaintenanceStore,
	now = new Date().toISOString(),
): Promise<CapacityWorkdayMaintenanceResult> {
	const [workdays, assignments, retention] = await Promise.all([
		store.maintainCapacityWorkdayRuns(null, now),
		store.recoverExpiredProviderAssignments({ now, limit: 200 }),
		store.maintainCapacityRuntimeRetention(now),
	]);
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
