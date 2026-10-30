import { describe, expect, it } from 'vitest';
import { assignmentAttemptSchema, assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { buildAssignmentAttempt } from '../../../../../../../../src/api/capacity/services/capacity/assignments/planning/execution/assignment-attempt-builder.ts';
import { canonicalOfferBuildInput } from '../../../fixtures/assignment-attempt-fixtures.ts';
import { dependencyAdmission } from './dependency-admission-fixture.ts';

describe('ordinary source integration through original SQL admission', () => {
	it('admits and replays one source-only integration with two exact reviewed predecessor branches and unchanged prior custody', async () => {
		const f = await dependencyAdmission();
		try {
			// Exact completion and review rows are controlled fixture inputs, not
			// actual model execution, Git materialization, charge or teardown proof.
			const actor = assignmentResultSchema.parse({ ...f.actor, id: 'second-source-result', assignmentId: 'second-source-attempt',
				references: [{ kind: 'git', repository: 'treeseed-ai/sdk', commit: '8'.repeat(40) }] });
			const review = assignmentResultSchema.parse({ ...f.review, id: 'second-review-result', assignmentId: 'second-review-attempt' });
			const actors = assignmentAttemptSchema.parse({ ...f.actorAttempt, id: actor.assignmentId, idempotencyKey: actor.assignmentId,
				nodeId: 'second-source-node', workItemId: 'second-source', reservationId: 'second-source-reservation' });
			const reviews = assignmentAttemptSchema.parse({ ...f.reviewAttempt, id: review.assignmentId, idempotencyKey: review.assignmentId,
				nodeId: 'second-review-node', workItemId: 'second-source', reservationId: 'second-review-reservation', predecessorResultIds: [actor.id] });
			for (const [attempt, result, originalId] of [[actors, actor, f.actor.assignmentId], [reviews, review, f.review.assignmentId]] as const) {
				await f.seedNode(attempt);
				await f.query("UPDATE execution_nodes SET status='completed',pair_role=?,kind=?,work_item_id=? WHERE id=?",
					[attempt === actors ? 'actor' : 'reviewer', attempt === actors ? 'acting' : 'reviewing', attempt.workItemId, attempt.nodeId]);
				await f.query(`INSERT INTO capacity_provider_assignments (id,membership_id,team_id,project_id,capacity_provider_id,project_agent_class_id,
					work_day_id,mode,status,lease_state,execution_node_id,execution_node_revision,graph_revision,assignment_attempt_json,assignment_result_json,
					lifecycle_output_json,completed_at,created_at,updated_at)
					SELECT ?,membership_id,team_id,project_id,capacity_provider_id,project_agent_class_id,work_day_id,mode,status,lease_state,
					?,?,graph_revision,?,?,lifecycle_output_json,completed_at,created_at,updated_at FROM capacity_provider_assignments WHERE id=?`,
					[attempt.id, attempt.nodeId, attempt.nodeRevision, JSON.stringify(attempt), JSON.stringify(result), originalId]);
			}
			const supplied = canonicalOfferBuildInput(f.attempt.createdAt);
			Object.assign(supplied.candidate.node, { id: 'source-integration-node', teamId: f.attempt.teamId,
				projectId: f.attempt.projectId, agentClass: f.attempt.agentClass, workItemId: 'combine-reviewed-source' });
			supplied.run.id = f.attempt.workdayId; supplied.run.parameters.appliedPlan = f.plan;
			supplied.candidate.node.requestedPermissions!.content.read.push('decision');
			supplied.candidate.effectiveProfile.permissionCeiling.content.read.push('decision');
			supplied.candidate.predecessorResults = [f.actor, f.review, actor, review];
			supplied.candidate.contextRefs.push(f.decision, ...[f.actor, actor].flatMap(result => result.references.flatMap(ref =>
				ref.kind === 'git' ? [{ store: 'git' as const, model: 'repository', id: result.id, repository: ref.repository, commit: ref.commit }] : [])));
			const held = structuredClone(supplied), before = await f.snapshot();
			const built = buildAssignmentAttempt(supplied);
			expect(await f.snapshot()).toEqual(before);
			await f.seedNode(built.assignment);
			for (const [id, from, to, provenance] of [
				['second-review-pair', actors.nodeId, reviews.nodeId, 'review-pair'],
				['first-integration-input', f.reviewAttempt.nodeId, built.assignment.nodeId, 'work-item'],
				['second-integration-input', reviews.nodeId, built.assignment.nodeId, 'work-item'],
			]) await f.query(`INSERT INTO execution_edges (id,team_id,from_node_id,to_node_id,provenance,source_ref_json,graph_revision_created,created_at)
				VALUES (?,?,?,?,?,?,1,?)`, [id, f.attempt.teamId, from, to, provenance, JSON.stringify(f.attempt.sourceRef), f.attempt.createdAt]);
			const input = { ...f.input(built.assignment), predecessorResults: supplied.candidate.predecessorResults };
			const prior = await f.snapshot(), first = await f.admit(input), committed = await f.snapshot();
			expect(first.assignmentAttempt).toEqual(built.assignment);
			expect(first.workspaceContext.predecessorResults).toEqual(input.predecessorResults);
			expect(first.assignmentAttempt?.grant.tools).not.toContain('release');
			expect(committed.financial.capacity_reservations).toHaveLength(1);
			expect(committed.financial.capacity_usage_actuals).toEqual([]);
			expect(committed.financial.capacity_ledger_entries).toEqual([]);
			expect(committed.financial.capacity_provider_assignments.filter(row => row.id !== built.assignment.id)).toEqual(prior.financial.capacity_provider_assignments);
			for (const replay of await Promise.all([f.admit(input), f.admit(structuredClone(input))])) expect(replay).toEqual(first);
			expect(await f.snapshot()).toEqual(committed); expect(supplied).toEqual(held);
		} finally { await f.db.close(); }
	});
});
