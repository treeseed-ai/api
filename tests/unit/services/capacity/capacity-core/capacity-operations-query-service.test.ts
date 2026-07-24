import { describe, expect, it, vi } from 'vitest';
import { CapacityOperationsQueryService } from '../../../../../src/api/capacity/services/capacity/capacity-core/capacity-operations-query-service.ts';

function page<T>(items: T[]) {
	return { items, page: { limit: 50, hasMore: false, nextCursor: null } };
}

describe('capacity operations query service', () => {
	it('preserves bounded financial pages and classifies pending/interrupted work', async () => {
		const reservation = (id: string, state: string, metadata: Record<string, unknown> = {}) => ({ id, state, metadata });
		const store = {
			ensureInitialized: vi.fn(),
			getProjectCapacityDiagnostics: vi.fn().mockResolvedValue({ projectId: 'project-a' }),
			getProjectCapacitySummary: vi.fn().mockResolvedValue({ projectId: 'project-a', readiness: 'ready' }),
			listCapacityReservationsForProjectPage: vi.fn().mockResolvedValue(page([
				reservation('reservation-a', 'reserved'),
				reservation('reservation-b', 'continuation_required'),
				reservation('reservation-c', 'consumed', { checkpointId: 'checkpoint-a' }),
			])),
			listCapacityLedgerEntriesPage: vi.fn().mockResolvedValue(page([{ id: 'ledger-a' }])),
			listTaskUsageActualsForProject: vi.fn().mockResolvedValue([{ id: 'usage-a' }]),
			listApprovalRequestsForProject: vi.fn().mockResolvedValue([
				{ id: 'approval-a', state: 'pending' }, { id: 'approval-b', state: 'approved' },
			]),
		};
		const result = await new CapacityOperationsQueryService(store as never).project('project-a', 'local');
		expect(result).toMatchObject({
			projectId: 'project-a', environment: 'local',
			reservationPage: { limit: 50, hasMore: false }, ledgerPage: { limit: 50, hasMore: false },
		});
		expect(result.pendingApprovalRequests.map((request) => request.id)).toEqual(['approval-a']);
		expect(result.interruptionReservations.map((entry) => entry.id)).toEqual(['reservation-b', 'reservation-c']);
		expect(store.listCapacityReservationsForProjectPage).toHaveBeenCalledWith('project-a', { limit: 50 });
		expect(store.listTaskUsageActualsForProject).toHaveBeenCalledWith('project-a', 50);
	});

	it('propagates a failed evidence read instead of returning a partial projection', async () => {
		const failure = new Error('ledger unavailable');
		const store = {
			ensureInitialized: vi.fn(),
			getProjectCapacityDiagnostics: vi.fn().mockResolvedValue(null),
			getProjectCapacitySummary: vi.fn().mockResolvedValue(null),
			listCapacityReservationsForProjectPage: vi.fn().mockResolvedValue(page([])),
			listCapacityLedgerEntriesPage: vi.fn().mockRejectedValue(failure),
			listTaskUsageActualsForProject: vi.fn().mockResolvedValue([]),
			listApprovalRequestsForProject: vi.fn().mockResolvedValue([]),
		};
		await expect(new CapacityOperationsQueryService(store as never).project('project-a')).rejects.toBe(failure);
	});
});
