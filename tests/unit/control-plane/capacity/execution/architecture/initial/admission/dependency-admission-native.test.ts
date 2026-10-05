import { describe, expect, it } from 'vitest';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { dependencyAdmission } from './dependency-admission-fixture.ts';

describe('original SQL dependency custody admission', () => {
	it('real owning admission denies undeclared tool-group authority before SQL and preserves failed inputs across exact retry', async () => {
		const f = await dependencyAdmission(); try {
			const input = f.input(); Object.assign(input.assignment.grant, { tools: [...input.assignment.grant.tools, 'invented-authority'] });
			const held = structuredClone(input), before = await f.snapshot(), observations = [];
			for (let retry = 0; retry < 2; retry++) {
				const [outcome] = await Promise.allSettled([f.admit(input)]);
				if (!outcome) throw new Error('Actual native admission observation required.');
				const error: unknown = outcome.status === 'rejected' ? outcome.reason : undefined;
				observations.push({ status: outcome.status, code: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
					statusCode: error && typeof error === 'object' && 'status' in error ? error.status : undefined,
					stateUnchanged: JSON.stringify(await f.snapshot()) === JSON.stringify(before), inputUnchanged: JSON.stringify(input) === JSON.stringify(held) });
			}
			expect(observations).toEqual(Array.from({ length: 2 }, () => ({ status: 'rejected', code: 'execution_assignment_authority_mismatch',
				statusCode: 409, stateUnchanged: true, inputUnchanged: true })));
		} finally { await f.db.close(); }
	});
	it('real owning admission rejects duplicated canonical references before writes and retains invalid input across exact retries', async () => {
		const observed: Array<{ mode: string; status: string; code?: string; statusCode?: number; stateUnchanged: boolean; inputUnchanged: boolean }> = [];
		for (const mode of ['authority', 'context', 'read-grant', 'result'] as const) {
			const f = await dependencyAdmission(); try {
				const input = f.input();
				if (mode === 'authority') input.assignment = { ...input.assignment, authorityRefs: [...input.assignment.authorityRefs, structuredClone(input.assignment.authorityRefs[0]!)] };
				if (mode === 'context') input.assignment = { ...input.assignment, contextRefs: [...input.assignment.contextRefs, structuredClone(input.assignment.contextRefs[0]!)] };
				if (mode === 'read-grant') input.assignment = { ...input.assignment, grant: { ...input.assignment.grant,
					contentRead: [...input.assignment.grant.contentRead, structuredClone(input.assignment.grant.contentRead[0]!)] } };
				if (mode === 'result') {
					const invalid = { ...f.actor, references: [...f.actor.references, structuredClone(f.actor.references[0]!)] };
					input.predecessorResults = [invalid, f.review];
					// Deliberately invalid supplied stored/input authority matches exactly;
					// a late byte-mismatch fence must not disguise missing validation.
					await f.query('UPDATE capacity_provider_assignments SET assignment_result_json=? WHERE id=?', [JSON.stringify(invalid), f.actor.assignmentId]);
				}
				const before = await f.snapshot(), held = structuredClone(input);
				for (let retry = 0; retry < 2; retry++) {
					const [outcome] = await Promise.allSettled([f.admit(input)]);
					if (!outcome) throw new Error('Native admission observation required.');
					const error: unknown = outcome.status === 'rejected' ? outcome.reason : undefined;
					observed.push({ mode, status: outcome.status,
						...(error && typeof error === 'object' ? {
							code: 'code' in error && typeof error.code === 'string' ? error.code : undefined,
							statusCode: 'status' in error && typeof error.status === 'number' ? error.status : undefined } : {}),
						stateUnchanged: JSON.stringify(await f.snapshot()) === JSON.stringify(before), inputUnchanged: JSON.stringify(input) === JSON.stringify(held) });
				}
			} finally { await f.db.close(); }
		}
		expect(observed).toEqual(['authority', 'context', 'read-grant', 'result'].flatMap(mode => Array.from({ length: 2 }, () => ({
			mode, status: 'rejected', statusCode: 409, code: mode === 'result' ? 'assignment_predecessor_authority_mismatch' : 'execution_assignment_authority_mismatch',
			stateUnchanged: true, inputUnchanged: true }))));
	});
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
