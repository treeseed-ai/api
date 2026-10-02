import { describe, expect, it } from 'vitest';
import { admitLivingExecutionAssignment } from '../../../../../../src/api/capacity/services/capacity/assignments/admission/living-execution-admission.ts';
import { replayAttempt, replayChanges, replayInput } from './admission-replay-fixture.ts';

// UNIT collaborator returns a previously stored snapshot; SQL proof is separate.
function replayStore() {
	const value = replayAttempt();
	const stored = { id: value.id, teamId: value.teamId, capacityProviderId: 'provider', executionNodeId: value.nodeId,
		executionNodeRevision: value.nodeRevision, assignmentAttempt: structuredClone(value) };
	return { stored, store: { getProviderAssignment: async () => stored } as unknown as Parameters<typeof admitLivingExecutionAssignment>[0] };
}

describe('immutable admission replay authority', () => {
	it('returns an identical replay without rewriting the original input or stored snapshot', async () => {
		const { store, stored } = replayStore(), input = replayInput(replayAttempt()), before = structuredClone({ input, stored });
		await expect(admitLivingExecutionAssignment(store, input)).resolves.toBe(stored);
		expect({ input, stored }).toEqual(before);
	});
	for (const { name, change } of replayChanges) it(`rejects replay changes to ${name}`, async () => {
		const { store, stored } = replayStore(), value = replayAttempt(); change(value);
		const input = replayInput(value), before = structuredClone({ input, stored });
		const outcome = await admitLivingExecutionAssignment(store, input).then(value => ({ value }), error => ({ error }));
		expect({ input, stored }).toEqual(before);
		expect('error' in outcome, `Changed ${name} must not be admitted`).toBe(true);
	});
	it('rejects a replay by an unrelated team or capacity provider', async () => {
		const outcomes = [];
		for (const principal of [{ teamId: 'other-team' }, { capacityProviderId: 'other-provider' }]) {
			const { store } = replayStore(), input = replayInput(replayAttempt());
			Object.assign(input.principal, principal);
			outcomes.push(await admitLivingExecutionAssignment(store, input).then(value => ({ value }), error => ({ error })));
		}
		expect(outcomes.every(outcome => 'error' in outcome), 'Both unrelated principals must be denied').toBe(true);
	});
	it('rejects an identity already bound to another node revision', async () => {
		const { store } = replayStore(), input = replayInput(replayAttempt()); input.assignment.nodeRevision += 1;
		await expect(admitLivingExecutionAssignment(store, input)).rejects.toMatchObject({ code: 'execution_assignment_idempotency_conflict' });
	});
});
