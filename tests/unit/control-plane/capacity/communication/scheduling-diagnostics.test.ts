import { describe, expect, it, vi } from 'vitest';
import { communicationSchedulingDiagnostics } from '../../../../../src/api/control-plane/repositories/capacity/communication/scheduling-diagnostics.ts';
import { selectWorkdayDemandSupply } from '../../../../../src/api/capacity/repositories/capacity/workdays/workday-demand-supply.ts';

vi.mock('../../../../../src/api/capacity/repositories/capacity/workdays/workday-demand-supply.ts', () => ({ selectWorkdayDemandSupply: vi.fn() }));

function fixture() {
	const store = {
		first: vi.fn(async (sql: string) => sql.includes('capacity_workday_runs')
			? { status: 'running', parameters_json: JSON.stringify({ executionMode: 'production', prompt: 'PRIVATE' }) }
			: { id: 'session', status: 'running' }),
		all: vi.fn(async (sql: string) => {
			if (sql.includes('capacity_audit_events')) return [{ created_at: 'now', metadata_json: JSON.stringify({ reasons: ['capacity_team_library_not_ready'], message: 'PRIVATE', details: { token: 'PRIVATE' } }) }];
			if (sql.includes('SELECT demand.*')) return [{ id: 'demand' }];
			if (sql.includes('COUNT(*)')) return [{ status: 'pending', count: '1' }];
			return [{ id: 'wave', status: 'running', round: '1', wave: '1' }];
		}),
	};
	vi.mocked(selectWorkdayDemandSupply).mockResolvedValue({ selected: null, eligible: [], rejected: [], policy: {} } as any);
	return store;
}

describe('unassigned chat scheduling diagnostics', () => {
	it('reports pending demand and denial codes without exposing stored content', async () => {
		const store = fixture(); const result = await communicationSchedulingDiagnostics(store, 'team', 'run');
		expect(result).toMatchObject({ executionMode: 'production', sessionStatus: 'running', demands: [{ status: 'pending', count: 1 }], supply: [{ demandId: 'demand', denials: [{ code: 'capacity_team_library_not_ready', at: 'now' }] }] });
		expect(JSON.stringify(result)).not.toContain('PRIVATE');
		expect(store.first.mock.calls[0][0]).toContain('team_id=?');
		expect(store.all.mock.calls.filter(([sql]) => !sql.includes('workday_planning_waves')).every(([sql]) => sql.includes('team_id=?'))).toBe(true);
	});
	it('does not inspect a run outside the authorized team', async () => {
		const store = fixture(); store.first.mockResolvedValue(null as any);
		expect(await communicationSchedulingDiagnostics(store, 'other-team', 'run')).toBeNull();
		expect(store.all).not.toHaveBeenCalled();
	});
	it('does not turn a diagnostics failure into a failed send or expose its error', async () => {
		const store = fixture(); store.first.mockRejectedValue(new Error('PRIVATE'));
		expect(await communicationSchedulingDiagnostics(store, 'team', 'run')).toEqual({ executionId: 'run', status: 'unavailable', code: 'communication_scheduling_diagnostics_unavailable' });
	});
});
