import {admissionUnitCollaborators} from '../fixtures/admission-unit-collaborators.ts';
admissionUnitCollaborators();
import { describe, expect, it } from 'vitest';
import { admitLivingExecutionAssignment } from '../../../../../../src/api/capacity/services/capacity/assignments/admission/living-execution-admission.ts';
import { advanceAssignmentAttemptLifecycle } from '../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import { replayAttempt, replayChanges, replayInput } from './admission-replay-fixture.ts';

// UNIT collaborator returns a previously stored snapshot; SQL proof is separate.
function replayStore() {
	const value = replayAttempt();
	const stored = { id: value.id, teamId: value.teamId, capacityProviderId: 'provider', executionNodeId: value.nodeId,
		executionNodeRevision: value.nodeRevision, assignmentAttempt: structuredClone(value), explanation: {} };
	return { stored, store: { getProviderAssignment: async () => stored } as unknown as Parameters<typeof admitLivingExecutionAssignment>[0] };
}

describe('immutable admission replay authority', () => {
	it('identifies the rejected original assignment and differing authority fields without exposing authority values', async () => {
		const { store, stored } = replayStore(), input = replayInput(replayAttempt());
		input.assignment.graphRevision += 1;
		input.assignment.effectiveProfile.parameters = { privateValue: 'must-not-appear-in-diagnostic' };
		const before = structuredClone({ input, stored });
		const error = await admitLivingExecutionAssignment(store, input).then(() => null, error => error);
		expect(error).toMatchObject({ code: 'execution_assignment_idempotency_conflict', status: 409,
			details: { assignmentId: input.assignment.id, nodeId: input.assignment.nodeId,
				nodeRevision: input.assignment.nodeRevision, workdayId: input.assignment.workdayId,
				retainedNodeId: stored.executionNodeId, retainedNodeRevision: stored.executionNodeRevision,
				changedAuthorityFields: ['effectiveProfile', 'graphRevision'] } });
		expect(JSON.stringify(error.details)).not.toContain('must-not-appear-in-diagnostic');
		expect({ input, stored }).toEqual(before);
	});
	it('retains the exact concurrently committed admission after an absent first lookup and denies changed or missing late snapshots without writes', async () => {
		for (const variant of ['exact', 'foreign-provider', 'changed-attempt', 'missing'] as const) {
			const { store, stored } = replayStore(), input = replayInput(replayAttempt());
			if (variant === 'foreign-provider') stored.capacityProviderId = 'foreign-provider';
			if (variant === 'changed-attempt') stored.assignmentAttempt.provider.runtimeBuild = `sha256:${'f'.repeat(64)}`;
			const before = structuredClone({ input, stored }), originalLookup = store.getProviderAssignment;
			let lookups = 0, reads = 0, writes = 0;
			store.getProviderAssignment = async (team, id) => ++lookups === 1 || variant === 'missing' ? null : originalLookup(team, id);
			store.first = async () => { reads++; return null; };
			store.batch = async () => { writes++; throw new Error('Unexpected new admission batch'); };
			const outcome = await admitLivingExecutionAssignment(store, input).then(value => ({ value }), error => ({ error }));
			if (variant === 'exact') expect(outcome).toEqual({ value: stored });
			else expect(outcome).toMatchObject({ error: { status: 409, code: variant === 'missing'
				? 'execution_assignment_authority_mismatch' : 'execution_assignment_idempotency_conflict' } });
			expect({ lookups, reads, writes }).toEqual({ lookups: 2, reads: 1, writes: 0 });
			expect({ input, stored }).toEqual(before);
		}
	});
	it('returns an identical replay without rewriting the original input or stored snapshot', async () => {
		const { store, stored } = replayStore(), input = replayInput(replayAttempt()), before = structuredClone({ input, stored });
		await expect(admitLivingExecutionAssignment(store, input)).resolves.toBe(stored);
		expect({ input, stored }).toEqual(before);
		for (const status of ['leased', 'running', 'completed', 'failed', 'cancelled', 'expired', 'blocked'] as const) {
			stored.assignmentAttempt = status === 'leased' ? advanceAssignmentAttemptLifecycle(input.assignment, status, input.now)
				: advanceAssignmentAttemptLifecycle(advanceAssignmentAttemptLifecycle(input.assignment, 'running', input.now), status, input.now);
			const held = structuredClone({ input, stored });
			expect(await Promise.all([admitLivingExecutionAssignment(store, input), admitLivingExecutionAssignment(store, input)])).toEqual([stored, stored]);
			expect({ input, stored }).toEqual(held);
			for (const { change } of replayChanges) { const changed = replayAttempt(); change(changed);
				await expect(admitLivingExecutionAssignment(store, replayInput(changed))).rejects.toThrow(); expect({ input, stored }).toEqual(held); }
		}
		for (const fields of [{ status: 'leased' as const }, { startedAt: input.now }, { finishedAt: input.now }]) {
			const value = replayAttempt(); Object.assign(value, fields); const changed = replayInput(value), held = structuredClone({ changed, stored });
			await expect(admitLivingExecutionAssignment(store, changed)).rejects.toMatchObject({ code: 'execution_assignment_authority_mismatch' });
			expect({ changed, stored }).toEqual(held);
		}
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
