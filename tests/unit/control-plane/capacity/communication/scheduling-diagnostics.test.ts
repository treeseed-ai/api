import { describe, expect, it, vi } from 'vitest';
import { communicationSchedulingDiagnostics } from '../../../../../src/api/control-plane/repositories/capacity/communication/scheduling-diagnostics.ts';

function fixture() {
	const store = {
		first: vi.fn(async (sql: string) => sql.includes('capacity_workday_runs')
			? { status: 'running', execution_mode: 'production', parameters_json: JSON.stringify({ prompt: 'PRIVATE' }) }
			: { id: 'session', status: 'running' }),
		all: vi.fn(async (sql: string) => {
			if (sql.includes('execution_nodes')) return [{ kind: 'communication', status: 'ready', count: '1' }];
			if (sql.includes('COUNT(*)')) return [{ status: 'pending', count: '1' }];
			return [{ id: 'wave', status: 'running', round: '1', wave: '1' }];
		}),
	};
	return store;
}

describe('unassigned chat scheduling diagnostics', () => {
	it('reports live graph and assignment counts without exposing stored content or retired demands', async () => {
		const store = fixture(); const result = await communicationSchedulingDiagnostics(store, 'team', 'run');
		expect(result).toMatchObject({ executionMode: 'production', sessionStatus: 'running', nodes: [{ kind: 'communication', status: 'ready', count: 1 }], assignments: [{ status: 'pending', count: 1 }] });
		expect(JSON.stringify(result)).not.toContain('PRIVATE');
		expect(store.first.mock.calls[0][0]).toContain('team_id=?');
		expect(store.all.mock.calls.every(([sql]) => !sql.includes('capacity_workday_demands'))).toBe(true);
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
