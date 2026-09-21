import { describe, expect, it } from 'vitest';
import { serializeCapacityReservationRow } from '../../../../../../src/api/capacity/repositories/capacity/accounting/reservation.ts';

describe('living-graph reservation record', () => {
	it('serializes a graph admission without a retired allocation set', () => {
		const row = {
			id: 'reservation', idempotency_key: 'attempt', membership_id: 'member', grant_id: null,
			capacity_provider_id: 'provider', execution_provider_id: 'execution', lane_id: 'workday',
			project_agent_class_id: 'class', assignment_id: 'assignment', mode: 'acting', team_id: 'team',
			project_id: 'project', work_day_id: 'workday', task_id: null, state: 'reserved',
			requested_seconds: 60, reserved_seconds: 60, active_seconds: 0, elapsed_seconds: 0,
			released_seconds: 0, overrun_seconds: 0, native_unit: null, reserved_native_amount: null,
			consumed_native_amount: null, reserved_provider_units: null, consumed_provider_units: null,
			reserved_usd: null, consumed_usd: null, expires_at: null, metadata_json: '{}',
			policy_snapshot_json: '{}', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
			allocation_set_id: null, allocation_version: null,
		};
		expect(serializeCapacityReservationRow(row)).toMatchObject({ id: 'reservation', grantId: null, assignmentId: 'assignment', reservedSeconds: 60 });
	});
});
