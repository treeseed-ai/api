import { describe, expect, it } from 'vitest';
import { CapacityLedgerRepository, serializeCapacityLedgerEntryRow } from '../../../src/api/capacity/repositories/ledger.ts';
import { CapacityReservationRepository, serializeCapacityReservationRow } from '../../../src/api/capacity/repositories/reservation.ts';

function reservationRow(overrides: Record<string, unknown> = {}) {
	return {
		id: 'reservation-a', idempotency_key: 'admit:a', membership_id: 'membership-a', grant_id: 'grant-a', capacity_provider_id: 'provider-a',
		execution_provider_id: 'codex', lane_id: 'default', allocation_set_id: 'allocation-a', allocation_version: 1,
		allocation_slice_ids_json: '["project:one"]', policy_snapshot_json: '{"allowed":true}', project_agent_class_id: 'class-a',
		assignment_id: 'assignment-a', mode: 'planning', team_id: 'team-a', project_id: 'project-a', work_day_id: 'workday-a', task_id: null,
		state: 'reserved', reserved_credits: 2, consumed_credits: 0, native_unit: 'token', reserved_native_amount: 10,
		consumed_native_amount: null, reserved_provider_units: null, consumed_provider_units: null, reserved_usd: null, consumed_usd: null,
		expires_at: null, metadata_json: '{}', created_at: '2026-07-18T00:00:00.000Z', updated_at: '2026-07-18T00:00:00.000Z', ...overrides,
	};
}

function ledgerRow(overrides: Record<string, unknown> = {}) {
	return {
		id: 'ledger-a', settlement_key: 'settle:a', membership_id: 'membership-a', capacity_provider_id: 'provider-a', reservation_id: 'reservation-a',
		assignment_id: 'assignment-a', mode_run_id: 'mode-a', mode: 'planning', team_id: 'team-a', project_id: 'project-a', work_day_id: 'workday-a',
		task_id: null, phase: 'task_completed_actual_settlement', credits: 2, provider_units: null, usd: null, source: 'provider', metadata_json: '{}',
		created_at: '2026-07-18T00:00:00.000Z', ...overrides,
	};
}

function database(rows: Record<string, unknown>[]) {
	return {
		ensureInitialized: async () => undefined,
		run: async () => undefined,
		first: async <T extends Record<string, unknown>>() => null as T | null,
		all: async <T extends Record<string, unknown>>() => rows as T[],
		batch: async () => undefined,
	};
}

describe('financial read repositories', () => {
	it('strictly serializes canonical reservation and ledger records', () => {
		expect(serializeCapacityReservationRow(reservationRow())).toMatchObject({ id: 'reservation-a', allocationVersion: 1, state: 'reserved', reservedCredits: 2 });
		expect(serializeCapacityLedgerEntryRow(ledgerRow())).toMatchObject({ id: 'ledger-a', phase: 'task_completed_actual_settlement', credits: 2 });
	});

	it('fails closed for malformed durable financial records', () => {
		expect(() => serializeCapacityReservationRow(reservationRow({ policy_snapshot_json: '[]' }))).toThrowError(/policy_snapshot_json/);
		expect(() => serializeCapacityReservationRow(reservationRow({ state: 'unknown' }))).toThrowError(/state/);
		expect(() => serializeCapacityLedgerEntryRow(ledgerRow({ metadata_json: '{' }))).toThrowError(/metadata_json/);
		expect(() => serializeCapacityLedgerEntryRow(ledgerRow({ phase: 'unknown' }))).toThrowError(/phase/);
	});

	it('uses deterministic keyset pages and rejects unknown filters', async () => {
		const reservations = new CapacityReservationRepository(database([
			reservationRow({ id: 'reservation-b' }), reservationRow({ id: 'reservation-a' }),
		]));
		const page = await reservations.listProjectPage('project-a', { limit: 1 });
		expect(page).toMatchObject({ items: [{ id: 'reservation-b' }], page: { limit: 1, hasMore: true } });
		expect(page.page.nextCursor).toEqual(expect.any(String));
		await expect(reservations.listProjectPage('project-a', { states: ['invented'] })).rejects.toMatchObject({ code: 'capacity_reservation_state_invalid' });

		const ledger = new CapacityLedgerRepository(database([ledgerRow()]));
		await expect(ledger.listProjectPage('project-a', { phases: ['invented'] })).rejects.toMatchObject({ code: 'capacity_ledger_phase_invalid' });
	});
});
