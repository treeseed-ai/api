interface CapacityCreditAggregateDatabase {
	first(query: string, values?: unknown[]): Promise<Record<string, unknown> | null>;
}

export interface CapacityCreditReservationTotals {
	activeReservedCredits: number;
	dailyUsedCredits: number;
	monthlyUsedCredits: number;
	dailyCommittedCredits: number;
	monthlyCommittedCredits: number;
	dailyWindowStartAt: string;
	monthlyWindowStartAt: string;
}

export async function aggregateCapacityCreditReservations(
	database: CapacityCreditAggregateDatabase,
	input: { teamId: string; projectId?: string | null; now?: Date | string | null },
): Promise<CapacityCreditReservationTotals> {
	const requestedAt = new Date(input.now ?? Date.now());
	const calculatedAt = Number.isFinite(requestedAt.getTime()) ? requestedAt : new Date();
	const dayStart = new Date(Date.UTC(calculatedAt.getUTCFullYear(), calculatedAt.getUTCMonth(), calculatedAt.getUTCDate())).toISOString();
	const monthStart = new Date(Date.UTC(calculatedAt.getUTCFullYear(), calculatedAt.getUTCMonth(), 1)).toISOString();
	const clauses = ['team_id = ?'];
	const scopeValues: unknown[] = [input.teamId];
	if (input.projectId) {
		clauses.push('project_id = ?');
		scopeValues.push(input.projectId);
	}
	const row = await database.first(
		`SELECT
			COALESCE(SUM(CASE WHEN state IN ('reserved', 'consuming') THEN
				CASE WHEN reserved_credits > consumed_credits THEN reserved_credits ELSE consumed_credits END
				ELSE 0 END), 0) AS active_reserved_credits,
			COALESCE(SUM(CASE WHEN updated_at >= ? THEN consumed_credits ELSE 0 END), 0) AS daily_used_credits,
			COALESCE(SUM(CASE WHEN updated_at >= ? THEN consumed_credits ELSE 0 END), 0) AS monthly_used_credits,
			COALESCE(SUM(CASE WHEN state IN ('consumed', 'failed', 'overran_pending_approval') AND updated_at >= ?
				THEN consumed_credits ELSE 0 END), 0) AS daily_terminal_credits,
			COALESCE(SUM(CASE WHEN state IN ('consumed', 'failed', 'overran_pending_approval') AND updated_at >= ?
				THEN consumed_credits ELSE 0 END), 0) AS monthly_terminal_credits
		 FROM capacity_reservations
		 WHERE ${clauses.join(' AND ')}`,
		[dayStart, monthStart, dayStart, monthStart, ...scopeValues],
	);
	const activeReservedCredits = Number(row?.active_reserved_credits ?? 0);
	return {
		activeReservedCredits,
		dailyUsedCredits: Number(row?.daily_used_credits ?? 0),
		monthlyUsedCredits: Number(row?.monthly_used_credits ?? 0),
		dailyCommittedCredits: activeReservedCredits + Number(row?.daily_terminal_credits ?? 0),
		monthlyCommittedCredits: activeReservedCredits + Number(row?.monthly_terminal_credits ?? 0),
		dailyWindowStartAt: dayStart,
		monthlyWindowStartAt: monthStart,
	};
}
