import type { NativeReservationDebitAggregate } from '@treeseed/sdk';

interface CapacityAggregateDatabase {
	first(query: string, values?: unknown[]): Promise<Record<string, unknown> | null>;
}

export interface NativeReservationAggregateInput {
	teamId: string;
	capacityProviderId: string;
	executionProviderId: string;
	nativeUnit: string;
	providerNativeUnit: string;
	projectId?: string | null;
	windowStartAt?: string | null;
	windowEndAt?: string | null;
}

function reservedAmountExpression(): string {
	return `CASE
		WHEN native_unit = ? THEN CASE
			WHEN COALESCE(reserved_native_amount, 0) > COALESCE(consumed_native_amount, 0)
			THEN COALESCE(reserved_native_amount, 0) ELSE COALESCE(consumed_native_amount, 0) END
		WHEN ? = 'usd' THEN CASE
			WHEN COALESCE(reserved_usd, 0) > COALESCE(consumed_usd, 0)
			THEN COALESCE(reserved_usd, 0) ELSE COALESCE(consumed_usd, 0) END
		WHEN ? = ? THEN CASE
			WHEN COALESCE(reserved_provider_units, 0) > COALESCE(consumed_provider_units, 0)
			THEN COALESCE(reserved_provider_units, 0) ELSE COALESCE(consumed_provider_units, 0) END
		ELSE 0 END`;
}

function consumedAmountExpression(): string {
	return `CASE
		WHEN native_unit = ? THEN COALESCE(consumed_native_amount, 0)
		WHEN ? = 'usd' THEN COALESCE(consumed_usd, 0)
		WHEN ? = ? THEN COALESCE(consumed_provider_units, 0)
		ELSE 0 END`;
}

export async function aggregateNativeReservationDebits(
	database: CapacityAggregateDatabase,
	input: NativeReservationAggregateInput,
): Promise<NativeReservationDebitAggregate> {
	const clauses = [
		'team_id = ?',
		'capacity_provider_id = ?',
		'(execution_provider_id = ? OR execution_provider_id IS NULL)',
	];
	const filterValues: unknown[] = [input.teamId, input.capacityProviderId, input.executionProviderId];
	if (input.projectId) {
		clauses.push('project_id = ?');
		filterValues.push(input.projectId);
	}
	const terminalWindow = input.windowStartAt ? ['updated_at >= ?'] : ['1 = 0'];
	const terminalWindowValues: unknown[] = input.windowStartAt ? [input.windowStartAt] : [];
	if (input.windowStartAt && input.windowEndAt) {
		terminalWindow.push('updated_at < ?');
		terminalWindowValues.push(input.windowEndAt);
	}
	const amountValues = [input.nativeUnit, input.nativeUnit, input.providerNativeUnit, input.nativeUnit];
	const row = await database.first(
		`SELECT
			COALESCE(SUM(CASE WHEN state IN ('reserved', 'consuming') THEN ${reservedAmountExpression()} ELSE 0 END), 0) AS active_reserved_native_amount,
			COALESCE(SUM(CASE WHEN state IN ('consumed', 'failed', 'overran_pending_approval')
				AND ${terminalWindow.join(' AND ')} THEN ${consumedAmountExpression()} ELSE 0 END), 0) AS active_consumed_native_amount
		 FROM capacity_reservations
		 WHERE ${clauses.join(' AND ')}`,
		[
			...amountValues,
			...terminalWindowValues,
			...amountValues,
			...filterValues,
		],
	);
	return {
		activeReservedNativeAmount: Number(row?.active_reserved_native_amount ?? 0),
		activeConsumedNativeAmount: Number(row?.active_consumed_native_amount ?? 0),
	};
}
