import { describe, expect, it } from 'vitest';
import { decideAssignmentRecovery, type RecoveryEvidence } from '../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-recovery-service.ts';
import { recoveryAssignment as assignment } from './cancellation-fixture.ts';
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
