interface CapacityTimeAggregateDatabase {
	first(query: string, values?: unknown[]): Promise<Record<string, unknown> | null>;
}

export interface CapacityTimeReservationTotals {
	activeReservedSeconds: number;
	dailyActiveSeconds: number;
	monthlyActiveSeconds: number;
	dailyCommittedSeconds: number;
	monthlyCommittedSeconds: number;
	dailyWindowStartAt: string;
	monthlyWindowStartAt: string;
}

export async function aggregateCapacityTimeReservations(
	database: CapacityTimeAggregateDatabase,
	input: { teamId: string; projectId?: string | null; now?: Date | string | null },
): Promise<CapacityTimeReservationTotals> {
	const requestedAt = new Date(input.now ?? Date.now());
	const calculatedAt = Number.isFinite(requestedAt.getTime()) ? requestedAt : new Date();
	const dayStart = new Date(Date.UTC(calculatedAt.getUTCFullYear(), calculatedAt.getUTCMonth(), calculatedAt.getUTCDate())).toISOString();
	const monthStart = new Date(Date.UTC(calculatedAt.getUTCFullYear(), calculatedAt.getUTCMonth(), 1)).toISOString();
	const clauses = ['team_id = ?'];
	const scopeValues: unknown[] = [input.teamId];
	if (input.projectId) { clauses.push('project_id = ?'); scopeValues.push(input.projectId); }
	const row = await database.first(
		`SELECT
			COALESCE(SUM(CASE WHEN state IN ('reserved', 'consuming') THEN reserved_seconds ELSE 0 END), 0) AS active_reserved_seconds,
			COALESCE(SUM(CASE WHEN updated_at >= ? THEN active_seconds ELSE 0 END), 0) AS daily_active_seconds,
			COALESCE(SUM(CASE WHEN updated_at >= ? THEN active_seconds ELSE 0 END), 0) AS monthly_active_seconds,
			COALESCE(SUM(CASE WHEN state IN ('consumed', 'failed', 'overran_pending_approval') AND updated_at >= ? THEN active_seconds ELSE 0 END), 0) AS daily_terminal_seconds,
			COALESCE(SUM(CASE WHEN state IN ('consumed', 'failed', 'overran_pending_approval') AND updated_at >= ? THEN active_seconds ELSE 0 END), 0) AS monthly_terminal_seconds
		 FROM capacity_reservations WHERE ${clauses.join(' AND ')}`,
		[dayStart, monthStart, dayStart, monthStart, ...scopeValues],
	);
	const activeReservedSeconds = Number(row?.active_reserved_seconds ?? 0);
	return {
		activeReservedSeconds,
		dailyActiveSeconds: Number(row?.daily_active_seconds ?? 0),
		monthlyActiveSeconds: Number(row?.monthly_active_seconds ?? 0),
		dailyCommittedSeconds: activeReservedSeconds + Number(row?.daily_terminal_seconds ?? 0),
		monthlyCommittedSeconds: activeReservedSeconds + Number(row?.monthly_terminal_seconds ?? 0),
		dailyWindowStartAt: dayStart,
		monthlyWindowStartAt: monthStart,
	};
}
