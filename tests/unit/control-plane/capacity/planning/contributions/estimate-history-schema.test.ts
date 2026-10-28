import { expect, it, vi } from 'vitest';
import { assignment as original } from '../../execution/fixtures/assignment.ts';

const readExactProposal = vi.hoisted(() => vi.fn());
vi.mock('../../../../../../src/api/governance/executable-proposal.ts', async importOriginal => ({
	...await importOriginal<typeof import('../../../../../../src/api/governance/executable-proposal.ts')>(), readExactProposal,
}));
import { isCurrentSubscriberContribution } from '../../../../../../src/api/capacity/services/capacity/assignments/planning/estimates/integration.ts';

it('marks a schema-obsolete frozen estimate as noncurrent without changing its retained authority', async () => {
	const assignment = { id: original.id, agentId: original.effectiveProfile.profileRef.id,
		teamId: original.teamId, projectId: original.projectId, assignmentAttempt: structuredClone(original) };
	const current = { executionPlan: { workItems: [{ estimateRef: {
		store: 'postgresql', model: 'assignment-attempt', id: original.id, revision: original.attempt,
	} }] } };
	const held = structuredClone({ assignment, current });
	const failure = Object.assign(new Error('Frozen historical proposal no longer satisfies the schema.'), {
		status: 422, code: 'proposal_execution_plan_invalid', diagnostics: [{ path: 'executionPlan.workItems.0.agentClass' }],
	});
	readExactProposal.mockRejectedValueOnce(failure);
	await expect(isCurrentSubscriberContribution({} as never, {}, current, assignment, {} as never)).resolves.toBe(false);
	expect({ assignment, current }).toEqual(held);
	expect(failure.diagnostics).toEqual([{ path: 'executionPlan.workItems.0.agentClass' }]);
});

it('preserves moved denied mismatched and unavailable frozen source failures instead of treating them as obsolete', async () => {
	for (const fields of [
	{ status: 409, code: 'proposal_execution_plan_invalid' },
	{ status: 409, code: 'proposal_snapshot_moved' },
	{ status: 409, code: 'proposal_digest_mismatch' },
	{ status: 409, code: 'proposal_identity_mismatch' },
	{ status: 403, code: 'forbidden' },
	{ status: 503, code: 'treedx_unavailable' },
	{ status: 500, code: undefined },
	]) {
	const failure = Object.assign(new Error('Exact frozen source read failed.'), fields);
	readExactProposal.mockRejectedValueOnce(failure);
	const current = { executionPlan: { workItems: [{ estimateRef: {
		store: 'postgresql', model: 'assignment-attempt', id: original.id, revision: original.attempt,
	} }] } };
	await expect(isCurrentSubscriberContribution({} as never, {}, current, {
		id: original.id, teamId: original.teamId, projectId: original.projectId,
		agentId: original.effectiveProfile.profileRef.id, assignmentAttempt: original,
	}, {} as never)).rejects.toBe(failure);
	}
});
