import { describe, expect, it, vi } from 'vitest';
import { decideAssignmentRecovery, recoverableLeaseSql, recoverExpiredProviderAssignments } from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-recovery-service.ts';

describe('assignment recovery eligibility', () => {
	it('retries only a graph-admitted attempt, and never equates an assignment result with graph completion', () => {
		const assignment = { id: 'assignment', executionKind: 'work', attemptCount: 0 } as never;
		const observed = { reservation: null, settlement: null, usageCount: 0, hasAssignmentResult: false,
			proxyEvents: 0, fallbackOutputs: 0, node: { id: 'node', status: 'assigned' },
			failoverAllowed: true, failoverCount: 1, invocationFinalMessageRef: null };
		expect(decideAssignmentRecovery(assignment, observed)).toMatchObject({ disposition: 'safe-retry', reasonCode: 'expired_lease_requeued' });
		expect(decideAssignmentRecovery(assignment, { ...observed, failoverAllowed: false })).toMatchObject({ disposition: 'terminal-failure' });
		expect(decideAssignmentRecovery(assignment, { ...observed, failoverCount: 3 }))
			.toMatchObject({ disposition: 'terminal-failure', reasonCode: 'expired_lease_retry_exhausted' });
		expect(decideAssignmentRecovery(assignment, { ...observed, settlement: { source: 'task_completed_actual_settlement' }, hasAssignmentResult: true }))
			.toMatchObject({ disposition: 'operator-action', reasonCode: 'expired_lease_completion_requires_graph_reconciliation' });
	});
	it('treats an expired lease or a closed provider session as the same recovery frontier', () => {
		const predicate = recoverableLeaseSql('assignment');
		expect(predicate).toContain('assignment.lease_expires_at <= ?');
		expect(predicate).toContain('recovery_session.id = assignment.provider_session_id');
		expect(predicate).toContain("recovery_session.status IN ('closed','expired')");
	});

	it('scans closed-session leases without waiting for their wall-clock expiry', async () => {
		const all = vi.fn(async () => []);
		const database = { ensureInitialized: vi.fn(async () => undefined), all };
		const result = await recoverExpiredProviderAssignments(database as never, {
			teamId: 'team-1', providerId: 'provider-1', now: '2026-09-14T12:00:00.000Z', limit: 10,
		});
		expect(result).toMatchObject({ scanned: 0, recovered: 0 });
		expect(all).toHaveBeenCalledOnce();
		const [query, parameters] = all.mock.calls[0]!;
		expect(query).toContain("recovery_session.status IN ('closed','expired')");
		expect(query).toContain('provider_session_id IS NOT NULL');
		expect(parameters).toEqual(['2026-09-14T12:00:00.000Z', 'team-1', 'provider-1', 10]);
	});
});
