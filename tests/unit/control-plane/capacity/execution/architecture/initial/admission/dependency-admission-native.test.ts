import { describe, expect, it } from 'vitest';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { dependencyAdmission } from './dependency-admission-fixture.ts';

describe('original SQL dependency custody admission', () => {
	it('initial owning admission freezes both exact predecessor results with one dependent reservation and unchanged supplied review history', async () => {
		const f = await dependencyAdmission(); try {
			const input = f.input(), original = structuredClone(input), before = await f.snapshot(), admitted = await f.admit(input);
			expect(admitted.assignmentAttempt).toEqual(input.assignment);
			expect(admitted.workspaceContext.predecessorResults).toEqual(input.predecessorResults);
			expect(input).toEqual(original);
			const after = await f.snapshot(); expect(after.edges).toEqual(before.edges);
			expect(after.financial.capacity_provider_assignments.filter(row => row.id !== f.attempt.id)).toEqual(before.financial.capacity_provider_assignments);
			expect(after.financial.capacity_reservations).toHaveLength(1);
			expect(after.financial.capacity_reservations[0]).toMatchObject({ assignment_id: f.attempt.id, reserved_seconds: f.attempt.limits.maximumSeconds, expires_at: f.attempt.deadline });
			expect(after.financial.capacity_usage_actuals).toEqual([]); expect(after.financial.capacity_ledger_entries).toEqual([]);
		} finally { await f.db.close(); }
	});
	it('missing failed malformed and duplicate supplied predecessor contexts deny initial native admission without orphan financial or proxy writes', async () => {
		for (const mode of ['missing', 'failed', 'malformed', 'duplicate'] as const) {
			const f = await dependencyAdmission(); try {
				const input = f.input();
				if (mode === 'missing') input.predecessorResults = [];
				if (mode === 'failed') input.predecessorResults[0] = { ...f.actor, status: 'failed' };
				if (mode === 'malformed') input.predecessorResults[1] = { ...f.review, assignmentId: '' };
				if (mode === 'duplicate') input.predecessorResults = [f.actor, f.actor];
				const before = await f.snapshot(), original = structuredClone(input);
				await expect(f.admit(input)).rejects.toThrow(); expect(await f.snapshot()).toEqual(before); expect(input).toEqual(original);
			} finally { await f.db.close(); }
		}
	});
	it('changed predecessor status revision result and review disposition after readiness deny the final native admission fence', async () => {
		for (const sql of [
			"UPDATE execution_nodes SET status='failed' WHERE id='review-node'",
			"UPDATE execution_nodes SET node_revision=node_revision+1 WHERE id='review-node'",
			"UPDATE capacity_provider_assignments SET assignment_result_json=NULL WHERE id='review-attempt'",
			`UPDATE capacity_provider_assignments SET lifecycle_output_json='{"activityCompletion":{"reviewDisposition":"request-changes"}}' WHERE id='review-attempt'`,
		]) {
			const f = await dependencyAdmission(); try {
				const input = f.input(), original = structuredClone(input); await f.query(sql); const before = await f.snapshot();
				await expect(f.admit(input)).rejects.toThrow(); expect(await f.snapshot()).toEqual(before); expect(input).toEqual(original);
			} finally { await f.db.close(); }
		}
	});
	it('concurrent exact and competing native dependent claims retain one immutable dependency snapshot and one reservation before read-only replay', async () => {
		const f = await dependencyAdmission(); try {
			const input = f.input(), other = f.input(assignmentAttemptSchema.parse({ ...f.attempt, id: 'competing-dependent', idempotencyKey: 'competing-dependent', reservationId: 'competing-dependent-reservation' }));
			const outcomes = await Promise.allSettled([f.admit(input), f.admit(input), f.admit(other)]);
			expect(outcomes.some(value => value.status === 'fulfilled')).toBe(true);
			const after = await f.snapshot(), dependent = after.financial.capacity_provider_assignments.filter(row => row.execution_node_id === f.attempt.nodeId);
			expect(dependent).toHaveLength(1); expect(after.financial.capacity_reservations).toHaveLength(1); expect(after.proxies).toHaveLength(1);
			const winner = dependent[0]!.id === input.assignment.id ? input : other;
			expect((await f.repository.get(winner.assignment.teamId, winner.assignment.id))?.workspaceContext.predecessorResults).toEqual(winner.predecessorResults);
			await f.admit(winner); expect(await f.snapshot()).toEqual(after);
		} finally { await f.db.close(); }
	});
	it('late native dependent assignment insertion interruption rolls back the reservation and retries identical dependency custody without deleting predecessor history', async () => {
		const f = await dependencyAdmission(); try {
			await f.db.exec(`CREATE FUNCTION reject_dependent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated dependent insertion interruption'; END $$;
				CREATE TRIGGER reject_dependent BEFORE INSERT ON capacity_provider_assignments FOR EACH ROW EXECUTE FUNCTION reject_dependent();`);
			const input = f.input(), original = structuredClone(input), before = await f.snapshot();
			await expect(f.admit(input)).rejects.toThrow('isolated dependent insertion interruption'); expect(await f.snapshot()).toEqual(before);
			await f.db.exec('DROP TRIGGER reject_dependent ON capacity_provider_assignments; DROP FUNCTION reject_dependent();');
			const admitted = await f.admit(input); expect(admitted.workspaceContext.predecessorResults).toEqual(input.predecessorResults); expect(input).toEqual(original);
			const after = await f.snapshot(); await f.admit(input); expect(await f.snapshot()).toEqual(after); expect(after.financial.capacity_reservations).toHaveLength(1);
		} finally { await f.db.close(); }
	});
});
