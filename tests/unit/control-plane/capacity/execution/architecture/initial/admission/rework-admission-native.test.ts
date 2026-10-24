import { describe, expect, it } from 'vitest';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { dependencyAdmission } from './dependency-admission-fixture.ts';

// The real failure occurs after a completed request-changes review advances
// both node revisions. These supplied histories exercise original admission
// SQL/transactions; they are not live provider/usage or release evidence.
async function reworkAdmission() {
	const f = await dependencyAdmission();
	try {
		const owned = (attempt: typeof f.actorAttempt, identity: string, digest: string) => assignmentAttemptSchema.parse({
			...attempt, effectiveProfile: { ...attempt.effectiveProfile, profileRef: { ...attempt.effectiveProfile.profileRef, id: identity } },
			authorityRefs: [...attempt.authorityRefs.filter(ref => !['agent', 'assignment-attempt'].includes(ref.model)),
				{ store: 'postgresql', model: 'agent', id: identity, digest: `sha256:${digest.repeat(64)}` },
				{ store: 'postgresql', model: 'assignment-attempt', id: `estimate-${identity.split('/').at(-1)}`, revision: 1 }],
		});
		const actor = owned({ ...f.actorAttempt, nodeId: f.attempt.nodeId }, 'configured/contract-owner', 'a');
		const reviewer = owned(f.reviewAttempt, 'configured/independent-peer', 'b');
		await f.query('UPDATE capacity_provider_assignments SET execution_node_id=?,assignment_attempt_json=?,decision_id=? WHERE id=?',
			[actor.nodeId, JSON.stringify(actor), 'decision', actor.id]);
		await f.query('UPDATE capacity_provider_assignments SET decision_id=?,assignment_attempt_json=?,lifecycle_output_json=? WHERE id=?',
			['decision', JSON.stringify(reviewer), JSON.stringify({ activityCompletion: { reviewDisposition: 'request-changes' } }), reviewer.id]);
		await f.query("DELETE FROM execution_edges WHERE id='review-dependent'");
		await f.query("UPDATE execution_edges SET from_node_id=? WHERE id='producer-review'", [actor.nodeId]);
		await f.query('DELETE FROM execution_nodes WHERE id=?', [f.actorAttempt.nodeId]);
		await f.query("UPDATE execution_nodes SET node_revision=2,pair_role='actor',work_item_id='producer',authority_refs_json=? WHERE id=?", [JSON.stringify(actor.authorityRefs), actor.nodeId]);
		await f.query("UPDATE execution_nodes SET node_revision=2,status='blocked',maximum_review_cycles=2,authority_refs_json=? WHERE id=?", [JSON.stringify(reviewer.authorityRefs), reviewer.nodeId]);
		const input = f.input(assignmentAttemptSchema.parse({ ...f.attempt, nodeRevision: 2, workItemId: 'producer',
			effectiveProfile: actor.effectiveProfile, authorityRefs: actor.authorityRefs }));
		return { ...f, actorAttempt: actor, reviewAttempt: reviewer, input: () => input };
	} catch (error) { await f.db.close(); throw error; }
}

describe('request-changes rework admission', () => {
	it('admits the next Actor revision with exact prior product and paired review, retaining history and one reservation on replay', async () => {
		const f = await reworkAdmission(); try {
			const input = f.input(), held = structuredClone(input), before = await f.snapshot();
			expect(f.actorAttempt.agentClass).toBe(f.reviewAttempt.agentClass);
			expect(f.actorAttempt.effectiveProfile.profileRef.id).not.toBe(f.reviewAttempt.effectiveProfile.profileRef.id);
			expect(f.actorAttempt.authorityRefs).not.toEqual(f.reviewAttempt.authorityRefs);
			const admitted = await f.admit(input);
			expect(admitted.assignmentAttempt).toEqual(input.assignment);
			expect(admitted.workspaceContext.predecessorResults).toEqual([f.actor, f.review]);
			const after = await f.snapshot();
			expect(after.financial.capacity_provider_assignments.filter(row => row.id !== input.assignment.id)).toEqual(before.financial.capacity_provider_assignments);
			expect(after.financial.capacity_reservations).toHaveLength(1);
			expect(after.financial.capacity_usage_actuals).toEqual([]);
			await f.admit(input); expect(await f.snapshot()).toEqual(after); expect(input).toEqual(held);
		} finally { await f.db.close(); }
	});
	it.each([
		['removed pair', "UPDATE execution_edges SET graph_revision_removed=2 WHERE id='producer-review'"],
		['foreign work item', "UPDATE execution_nodes SET work_item_id='other' WHERE id='review-node'"],
		['foreign project', "UPDATE execution_nodes SET project_id='other' WHERE id='review-node'"],
		['foreign run', "UPDATE capacity_provider_assignments SET work_day_id='other' WHERE id='review-attempt'"],
		['foreign Decision field', "UPDATE capacity_provider_assignments SET decision_id='other' WHERE id IN ('review-attempt','producer-attempt')"],
		['changed paired authority', "UPDATE execution_nodes SET authority_refs_json='[]' WHERE id='review-node'"],
		['changed pair source', "UPDATE execution_edges SET source_ref_json=jsonb_set(source_ref_json::jsonb,'{id}','\"other\"') WHERE id='producer-review'"],
		['changed review source', "UPDATE capacity_provider_assignments SET assignment_attempt_json=jsonb_set(assignment_attempt_json::jsonb,'{sourceRef,id}','\"other\"') WHERE id='review-attempt'"],
		['changed product authority', "UPDATE capacity_provider_assignments SET assignment_attempt_json=jsonb_set(assignment_attempt_json::jsonb,'{authorityRefs}','[]') WHERE id='producer-attempt'"],
		['changed historical reviewer authority', "UPDATE capacity_provider_assignments SET assignment_attempt_json=jsonb_set(assignment_attempt_json::jsonb,'{authorityRefs}','[]') WHERE id='review-attempt'"],
		['wrong review target', "UPDATE capacity_provider_assignments SET assignment_attempt_json=jsonb_set(assignment_attempt_json::jsonb,'{predecessorResultIds}','[\"other-result\"]') WHERE id='review-attempt'"],
		['unadvanced review revision', "UPDATE execution_nodes SET node_revision=1 WHERE id='review-node'"],
		['unpaired actor', "UPDATE execution_nodes SET pair_role=NULL WHERE id='node'"],
		['unblocked reviewer', "UPDATE execution_nodes SET status='ready' WHERE id='review-node'"],
		['approved history', `UPDATE capacity_provider_assignments SET lifecycle_output_json='{"activityCompletion":{"reviewDisposition":"approved"}}' WHERE id='review-attempt'`],
		['exhausted cycle', "UPDATE execution_nodes SET maximum_review_cycles=1 WHERE id='review-node'"],
	])('denies %s without changing retained history, counters, usage or reservations', async (_name, sql) => {
		const f = await reworkAdmission(); try {
			await f.query(sql); const before = await f.snapshot(), input = f.input(), held = structuredClone(input);
			await expect(f.admit(input)).rejects.toThrow();
			expect(await f.snapshot()).toEqual(before); expect(input).toEqual(held);
		} finally { await f.db.close(); }
	});
	it.each(['moved Decision', 'missing Decision'])('denies internally consistent reviewer custody with %s', async (change) => {
		const f = await reworkAdmission(); try {
			const refs = change === 'missing Decision'
				? f.reviewAttempt.authorityRefs.filter(ref => ref.model !== 'decision')
				: f.reviewAttempt.authorityRefs.map(ref => ref.model === 'decision' ? { ...ref, commit: 'c'.repeat(40) } : ref);
			await f.query('UPDATE execution_nodes SET authority_refs_json=? WHERE id=?', [JSON.stringify(refs), f.reviewAttempt.nodeId]);
			await f.query("UPDATE capacity_provider_assignments SET assignment_attempt_json=jsonb_set(assignment_attempt_json::jsonb,'{authorityRefs}',?::jsonb) WHERE id=?", [JSON.stringify(refs), f.reviewAttempt.id]);
			const before = await f.snapshot(), input = f.input(), held = structuredClone(input);
			await expect(f.admit(input)).rejects.toMatchObject({ code: 'execution_assignment_authority_mismatch' });
			expect(await f.snapshot()).toEqual(before); expect(input).toEqual(held);
		} finally { await f.db.close(); }
	});
	it('requires both exact rework results rather than admitting just the old product', async () => {
		const f = await reworkAdmission(); try {
			const input = f.input(); input.predecessorResults = [f.actor]; input.assignment.predecessorResultIds = [f.actor.id];
			const before = await f.snapshot(); await expect(f.admit(input)).rejects.toMatchObject({ code: 'execution_assignment_authority_mismatch' });
			expect(await f.snapshot()).toEqual(before);
		} finally { await f.db.close(); }
	});
	it('retains exact reviewed context across an explicitly returned Actor revision', async () => {
		const f = await reworkAdmission(); try {
			await f.query('UPDATE execution_nodes SET node_revision=3 WHERE id=?', [f.attempt.nodeId]);
			const input = f.input(); input.assignment.nodeRevision = 3;
			expect((await f.admit(input)).workspaceContext.predecessorResults).toEqual([f.actor, f.review]);
		} finally { await f.db.close(); }
	});
});
