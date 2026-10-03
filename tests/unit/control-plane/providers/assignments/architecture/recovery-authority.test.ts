import { describe, expect, it } from 'vitest';
import { emptyCapacityBudget } from '@treeseed/sdk/agent-capacity';
import { serializeProviderAssignmentRow } from '../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import { decideAssignmentRecovery, type RecoveryEvidence } from '../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-recovery-service.ts';
import { frozenAttempt } from '../../../capacity/accounting/architecture/settlement-fixture.ts';

function assignment(started: boolean) {
	const budget = emptyCapacityBudget(frozenAttempt.deadline, frozenAttempt.limits.maximumSeconds);
	const result = serializeProviderAssignmentRow({ id: frozenAttempt.id, team_id: frozenAttempt.teamId,
		project_id: frozenAttempt.projectId, membership_id: 'membership', capacity_provider_id: 'provider',
		project_agent_class_id: frozenAttempt.agentClass, work_day_id: frozenAttempt.workdayId, mode: 'acting',
		status: 'leased', lease_state: 'leased', lease_token: 'lease-token', lease_expires_at: frozenAttempt.deadline,
		execution_kind: 'work', trigger_kind: 'graph', reservation_id: frozenAttempt.reservationId, attempt_count: 1,
		state_version: 1, execution_node_id: frozenAttempt.nodeId, execution_node_revision: frozenAttempt.nodeRevision,
		assignment_attempt_json: JSON.stringify({ ...frozenAttempt, status: 'created' }), created_at: frozenAttempt.createdAt,
		updated_at: frozenAttempt.createdAt, capacity_envelope_json: JSON.stringify({ teamId: 'team', projectId: 'project',
			mode: 'acting', budget: { ...budget, time: { ...budget.time,
				executionStartedAt: started ? frozenAttempt.createdAt : null, executionDeadlineAt: started ? frozenAttempt.deadline : null } } }) });
	if (!result) throw new Error('Missing isolated full assignment');
	return result;
}
const evidence: RecoveryEvidence = { reservation: { id: 'reservation' }, settlement: null, usageCount: 0,
	hasAssignmentResult: false, proxyEvents: 0, fallbackOutputs: 0, node: { id: 'report-node', status: 'running' },
	failoverAllowed: true, failoverCount: 1, invocationFinalMessageRef: null };
// UNIT pure recovery classification/serializer. Missing measurements are not proof of zero execution.
describe('recovery respects immutable executed-attempt and measurement authority', () => {
	it('does not authorize a zero-cost safe retry when an execution clock started but terminal usage is unknown', () => {
		const input = assignment(true), before = structuredClone(input), observed = structuredClone(evidence);
		expect(decideAssignmentRecovery(input, observed).disposition).toBe('operator-action');
		expect(input).toEqual(before); expect(observed).toEqual(evidence);
	});
	it('preserves no-execution retry and financial uncertainty side-effect result and bounded failover denials', () => {
		const input = assignment(false), before = structuredClone(input);
		expect(decideAssignmentRecovery(input, evidence)).toMatchObject({ disposition: 'safe-retry', status: 'failed' });
		for (const change of [{ reservation: { settlement_token: 'pending' } }, { usageCount: 1 },
			{ hasAssignmentResult: true }, { proxyEvents: 1 }, { fallbackOutputs: 1 }]) {
			expect(decideAssignmentRecovery(input, { ...evidence, ...change }).disposition).toBe('operator-action');
		}
		expect(decideAssignmentRecovery(input, { ...evidence, failoverAllowed: false }).disposition).toBe('terminal-failure');
		expect(decideAssignmentRecovery(input, { ...evidence, failoverCount: 3 }).reasonCode).toBe('expired_lease_retry_exhausted');
		expect(input).toEqual(before);
	});
});
