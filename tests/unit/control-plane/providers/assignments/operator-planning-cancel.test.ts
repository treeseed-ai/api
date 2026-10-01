import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ assignment: {} as Record<string, unknown>, run: null as Record<string, unknown> | null,
	settle: vi.fn() }));
vi.mock('../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts', () => ({
	ProviderAssignmentRepository: class { async getForCancellation() { return fixture.assignment; } },
}));
vi.mock('../../../../../src/api/capacity/repositories/capacity/workdays/workday-run.ts', () => ({
	CapacityWorkdayRunRepository: class { async get() { return fixture.run; } },
}));
vi.mock('../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts', () => ({
	releaseCapacityReservationsExactlyOnce: fixture.settle,
}));
import { OperatorAssignmentService } from '../../../../../src/api/capacity/services/capacity/assignments/observability/operator-assignment-service.ts';

const boundary = '2026-10-01T01:16:28.362Z';
function setup(ready = true) {
	vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T01:16:29.000Z')); fixture.settle.mockClear();
	fixture.run = { status: 'running', capacityProviderId: 'provider', parameters: { scheduledProjectIds: ['project'], appliedPlan: {
		schemaVersion: 'treeseed.workday/v1', id: 'workday', teamId: 'team', executionMode: 'simulation', policyId: 'default',
		policyRevision: 4, state: 'active', startsAt: '2026-10-01T00:56:28.362Z', endsAt: '2026-10-01T01:56:28.362Z',
		planningRounds: [], admittedSecondsByProject: {}, admittedSecondsByAgentClass: {},
		policySnapshot: { durationSeconds: 3600, planningPercent: 100 / 3, allocationWeight: 1, planningTurnMaximumSeconds: 180,
			maximumConcurrency: 5, communicationConcurrency: 5, projectPercentages: { project: 100 },
			agentClassPercentages: { project: { engineer: 100 } } },
	} } };
	fixture.assignment = { id: 'assignment', teamId: 'team', projectId: 'project', capacityProviderId: 'provider',
		workDayId: 'workday', status: 'returned', leaseState: 'released', stateVersion: 4, reservationId: 'reservation',
		membershipId: 'membership', claimedAt: '2026-10-01T01:16:26.270Z', metadata: {},
		assignmentAttempt: { effectiveProfile: { activity: 'planning' } },
		capacityEnvelope: { budget: { time: { authorityDeadlineAt: boundary, preparationDeadlineAt: boundary } } },
		lifecycleOutput: { teardown: { verified: true, completedAt: boundary }, completion: { disposition: 'completed' }, performance: null } };
	const first = vi.fn(async (query: string, params: unknown[]) => {
		if (query.includes("node.kind IN ('acting','reviewing')")) return ready ? { id: 'actor' } : null;
		if (query.includes('capacity_usage_actuals')) return { active_seconds: 0, elapsed_seconds: 2.635 };
		if (query.startsWith('UPDATE capacity_provider_assignments SET status')) {
			fixture.assignment = { ...fixture.assignment, status: 'cancelled', leaseState: 'released' };
			return { id: 'assignment', params };
		}
		return null;
	});
	const database = { ensureInitialized: vi.fn(), first, batch: vi.fn() };
	return { database, service: new OperatorAssignmentService(database as never) };
}
afterEach(() => vi.useRealTimers());
describe('operator planning boundary closeout', () => {
	it('normalizes a claimed returned turn without replacing the provider closure or measured usage', async () => {
		const { service, database } = setup();
		await service.cancel('team', 'assignment', { idempotencyKey: 'ordinary-key' });
		const write = database.first.mock.calls.find(([query]) => query.startsWith('UPDATE capacity_provider_assignments SET status'))!;
		expect(write[0]).toContain('failed_at = COALESCE(failed_at, ?)');
		expect(write[1]).toContain('planning_boundary_cancelled');
		const output = write[1].filter(value => typeof value === 'string').map(value => { try { return JSON.parse(value as string); } catch { return null; } })
			.find(value => value?.performance);
		expect(output).toMatchObject({ teardown: { verified: true, completedAt: boundary },
			completion: { disposition: 'cancelled' }, performance: { disposition: 'cancelled', actual: { activeSeconds: 0, elapsedSeconds: 2.635 } } });
		expect(fixture.settle).toHaveBeenCalledOnce();
	});
	it('does not invent isolation teardown when the provider supplied no receipt', async () => {
		const { service, database } = setup(); fixture.assignment.lifecycleOutput = {};
		await service.cancel('team', 'assignment', { idempotencyKey: 'phase' });
		const write = database.first.mock.calls.find(([query]) => query.startsWith('UPDATE capacity_provider_assignments SET status'))!;
		const output = write[1].filter(value => typeof value === 'string').map(value => { try { return JSON.parse(value as string); } catch { return null; } })
			.find(value => value?.performance);
		expect(output?.teardown).toBeUndefined();
		expect(output?.performance.disposition).toBe('cancelled');
	});
	it.each(['earlier', 'acting', 'fluid', 'wrong-provider'])('preserves ordinary cancellation for %s despite a planning-looking reason or key', async kind => {
		const { service, database } = setup(kind !== 'fluid');
		if (kind === 'earlier') vi.setSystemTime(new Date('2026-10-01T01:16:27.000Z'));
		if (kind === 'acting') fixture.assignment.assignmentAttempt = { effectiveProfile: { activity: 'acting' } };
		if (kind === 'wrong-provider') fixture.run!.capacityProviderId = 'other';
		await service.cancel('team', 'assignment', { idempotencyKey: 'planning-boundary:workday', reason: 'Planning window ended.' });
		const write = database.first.mock.calls.find(([query]) => query.startsWith('UPDATE capacity_provider_assignments SET status'))!;
		expect(write[1]).toContain('operator_cancelled');
		expect(write[1]).not.toContain('planning_boundary_cancelled');
	});
});
