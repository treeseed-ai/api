import { describe, expect, it } from 'vitest';
import { terminalPerformance } from '../../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/completion/assignment-terminal-performance.ts';
import { recoveryAssignment, cancelNow } from '../../architecture/cancellation-fixture.ts';

// UNIT of the owning performance projection; supplied clocks and measurements
// are not provider-generated usage or an independent timing receipt.
describe('truthful terminal performance projection', () => {
	it('requires actual time for an operator-action recovery even when its original active clock never started', () => {
		for (const reasonCode of ['expired_lease_execution_usage_unknown', 'expired_lease_side_effect_evidence_present',
			'expired_lease_financial_transition_uncertain']) {
			const item = recoveryAssignment(false);
			item.metadata = { ...item.metadata, leaseRecovery: { disposition: 'operator-action', reasonCode } };
			const before = structuredClone(item);
			for (const measurements of [{}, { elapsed_seconds: 1 }, { active_seconds: 0 }]) {
				expect(() => terminalPerformance(item, { completion: { disposition: 'cancelled' } }, 'failed', cancelNow, measurements))
					.toThrowError(expect.objectContaining({ code: 'provider_assignment_usage_required', status: 409 }));
				expect(item).toEqual(before);
			}
			const measured = { active_seconds: 2, elapsed_seconds: 3 }, held = structuredClone(measured);
			expect(terminalPerformance(item, {}, 'failed', cancelNow, measured).actual)
				.toMatchObject({ activeSeconds: 2, elapsedSeconds: 3 });
			expect(measured).toEqual(held); expect(item).toEqual(before);
		}
		// Truly unstarted, unclassified work retains the existing zero-release contract.
		expect(terminalPerformance(recoveryAssignment(false), {}, 'failed', cancelNow).actual)
			.toMatchObject({ activeSeconds: 0, elapsedSeconds: 0 });
	});
	it('retains supplied measured terminal time and arbitrary class without rewriting the frozen assignment', () => {
		const item = recoveryAssignment(true), before = structuredClone(item);
		const result = terminalPerformance(item, {}, 'failed', cancelNow, { active_seconds: 2, elapsed_seconds: 3, input_tokens: 7 });
		expect(result.actual).toMatchObject({ activeSeconds: 2, elapsedSeconds: 3, inputTokens: 7, attempts: item.assignmentAttempt!.attempt });
		expect(result.agentClassId).toBe(item.projectAgentClassId); expect(item).toEqual(before);
	});
	it('denies unknown terminal measurements after execution started instead of synthesizing zero usage', () => {
		const item = recoveryAssignment(true), before = structuredClone(item);
		let admitted = false;
		try { terminalPerformance(item, {}, 'failed', cancelNow); admitted = true; } catch { /* unknown productive usage denied */ }
		expect(item).toEqual(before); expect(admitted).toBe(false);
	});
	it('denies coerced or negative measured seconds instead of converting them into successful performance facts', () => {
		const item = recoveryAssignment(true), admitted: number[] = [];
		for (const [index, active] of ['2', -1].entries()) {
			try { terminalPerformance(item, {}, 'failed', cancelNow, { active_seconds: active, elapsed_seconds: 3 }); admitted.push(index); }
			catch { /* malformed measurements denied */ }
		}
		expect(admitted).toEqual([]);
	});
});
