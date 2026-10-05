import { describe, expect, it } from 'vitest';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { initialAdmission, invalidAdmissionBindings } from './initial-admission-fixture.ts';
import { CapacityGovernanceError } from '../../../../../../../src/api/capacity/database.ts';

describe('initial living assignment native admission', () => {
	it('native admission retains exact original selector inputs in one allocation explanation and denies changed replay history without replacing candidate reservation or financial bytes', async () => {
		const f = await initialAdmission();
		try {
			const input = f.input(), held = structuredClone(input);
			const originalInputs = { nodes: [{ id: f.attempt.nodeId, projectId: f.attempt.projectId, agentClass: f.attempt.agentClass, readyAt: f.attempt.createdAt }], usage: [] };
			expect(input.allocation.selection).toMatchObject({ id: f.attempt.nodeId, input: originalInputs });
			const admitted = await f.admit(input), committed = await f.snapshot();
			expect(admitted.explanation).toMatchObject({ metadata: { allocation: { selection: { id: f.attempt.nodeId, input: originalInputs } } } });
			const again = await f.repository.get(f.attempt.teamId, f.attempt.id);
			expect(again?.explanation).toEqual(admitted.explanation);
			for (const changes of [
				{ nodes: [], usage: [] },
				{ nodes: [{ ...originalInputs.nodes[0]!, id: 'foreign-ready-node' }], usage: [] },
				{ nodes: originalInputs.nodes, usage: [{ projectId: f.attempt.projectId, agentClass: f.attempt.agentClass, seconds: 1 }] },
			]) {
				const changed = structuredClone(input); Object.assign(changed.allocation.selection!, { input: changes });
				const before = structuredClone(changed);
				await expect(f.admit(changed)).rejects.toMatchObject({ status: 409 });
				expect(await f.snapshot()).toEqual(committed); expect(changed).toEqual(before);
			}
			for (const replay of await Promise.all([f.admit(input), f.admit(structuredClone(input))])) expect(replay.explanation).toEqual(admitted.explanation);
			expect(await f.snapshot()).toEqual(committed); expect(input).toEqual(held);
			// Original owning SQL transaction with supplied eligibility input.
			// This does not substitute for the scheduler producing a complete
			// hard-gated eligible set or native provider-global arbitration.
		} finally { await f.db.close(); }
	});
	it('native final admission refuses changed ready-node authority and conflicting provider execution bindings without counter reservation proxy or assignment residue', async () => {
		const f = await initialAdmission(); try {
			const input = f.input(), original = structuredClone(input), pristine = await f.snapshot(), outcomes = [];
			for (const variant of invalidAdmissionBindings(input)) {
				const before = structuredClone(variant.input); let failure: unknown;
				try { await f.admit(variant.input); } catch (error) { failure = error; }
				outcomes.push({ name: variant.name, owned: failure instanceof CapacityGovernanceError,
					code: failure instanceof CapacityGovernanceError ? failure.code : undefined,
					status: failure instanceof CapacityGovernanceError ? failure.status : undefined });
				expect(await f.snapshot()).toEqual(pristine); expect(variant.input).toEqual(before);
			}
			expect(outcomes).toEqual(invalidAdmissionBindings(input).map(({ name }) => ({ name, owned: true,
				code: 'execution_assignment_authority_mismatch', status: 409 })));
			const authorities = structuredClone(input.assignment.authorityRefs); authorities[0]!.digest = `sha256:${'f'.repeat(64)}`;
			const changes = [
				{ column: 'source_ref_json', original: JSON.stringify(input.assignment.sourceRef), value: JSON.stringify({ ...input.assignment.sourceRef, revision: input.assignment.sourceRef.revision! + 1 }) },
				{ column: 'source_ref_json', original: JSON.stringify(input.assignment.sourceRef), value: JSON.stringify({ ...input.assignment.sourceRef, commit: 'f'.repeat(40) }) },
				{ column: 'source_ref_json', original: JSON.stringify(input.assignment.sourceRef), value: JSON.stringify({ ...input.assignment.sourceRef, digest: `sha256:${'f'.repeat(64)}` }) },
				{ column: 'authority_refs_json', original: JSON.stringify(input.assignment.authorityRefs), value: JSON.stringify(authorities) },
				{ column: 'authority_refs_json', original: JSON.stringify(input.assignment.authorityRefs), value: '[]' },
				{ column: 'project_id', original: input.assignment.projectId, value: 'foreign-project' },
				{ column: 'workday_id', original: input.assignment.workdayId, value: 'foreign-workday' },
				{ column: 'agent_class', original: input.assignment.agentClass, value: 'foreign-class' },
				{ column: 'graph_revision_updated', original: input.assignment.graphRevision, value: input.assignment.graphRevision + 1 },
			];
			for (const change of changes) {
				// Column names come only from this literal original-schema inventory.
				await f.query(`UPDATE execution_nodes SET ${change.column}=? WHERE id=?`, [change.value, input.assignment.nodeId]);
				const changed = await f.snapshot();
				await expect(f.admit(input)).rejects.toMatchObject({ code: 'execution_assignment_authority_mismatch', status: 409 });
				expect(await f.snapshot()).toEqual(changed); expect(input).toEqual(original);
				// Restore only the deliberately supplied corrupt field; no failed
				// observations, actual reservations or producer history are deleted.
				await f.query(`UPDATE execution_nodes SET ${change.column}=? WHERE id=?`, [change.original, input.assignment.nodeId]);
				expect(await f.snapshot()).toEqual(pristine);
			}
			const admitted = await f.admit(input), committed = await f.snapshot(); expect(admitted.assignmentAttempt).toEqual(input.assignment);
			expect(committed.financial.capacity_reservations).toHaveLength(1); expect(committed.financial.capacity_provider_assignments).toHaveLength(1);
			expect(committed.proxies).toHaveLength(1); expect(committed.financial.capacity_usage_actuals).toEqual(pristine.financial.capacity_usage_actuals);
			expect(committed.financial.capacity_ledger_entries).toEqual(pristine.financial.capacity_ledger_entries);
			for (const replay of await Promise.all([f.admit(input), f.admit(structuredClone(input))])) expect(replay.assignmentAttempt).toEqual(input.assignment);
			expect(await f.snapshot()).toEqual(committed); expect(input).toEqual(original);
			// Original owning SQL/PGlite transaction, not independent PG pools,
			// governance-produced changes, signed enrollment or managed execution.
		} finally { await f.db.close(); }
	});
	it('claims one ready node with exact frozen authority one reservation and unchanged original caps', async () => {
		const f = await initialAdmission(); try {
			const input = f.input(), before = structuredClone(input), admitted = await f.admit(input);
			expect(admitted.assignmentAttempt).toEqual(f.attempt); expect(input).toEqual(before);
			expect(admitted.attemptCount).toBe(f.attempt.attempt);
			const state = await f.snapshot();
			expect(state.nodes).toEqual([expect.objectContaining({ id: f.attempt.nodeId, status: 'assigned', node_revision: 1 })]);
			expect(state.financial.capacity_reservations).toEqual([expect.objectContaining({ assignment_id: f.attempt.id,
				reserved_seconds: 3, expires_at: f.attempt.deadline })]);
			expect(state.financial.capacity_admission_counters).toEqual(expect.arrayContaining([
				expect.objectContaining({ hard_limit: 10, committed_amount: 4 })]));
			await f.admit(); expect(await f.snapshot()).toEqual(state);
		} finally { await f.db.close(); }
	});
	it('denies non-ready stale and foreign node claims without orphan reservation assignment or proxy', async () => {
		const outcomes = [];
		for (const sql of ["UPDATE execution_nodes SET status='blocked'", 'UPDATE execution_nodes SET node_revision=2',
			"UPDATE execution_nodes SET team_id='foreign-team'"]) {
			const f = await initialAdmission(); try {
				await f.query(sql); const before = await f.snapshot();
				const result = await f.admit().then(() => 'admitted', () => 'denied');
				const after = await f.snapshot();
				outcomes.push({ result, reservations: after.financial.capacity_reservations, assignments: after.financial.capacity_provider_assignments,
					proxies: after.proxies, nodesUnchanged: JSON.stringify(after.nodes) === JSON.stringify(before.nodes) });
			} finally { await f.db.close(); }
		}
		expect(outcomes).toEqual(outcomes.map(() => ({ result: 'denied', reservations: [], assignments: [], proxies: [], nodesUnchanged: true })));
	});
	it('matching and competing concurrent node claims retain one durable attempt and one counter reservation', async () => {
		const f = await initialAdmission(); try {
			const other = assignmentAttemptSchema.parse({ ...f.attempt, id: 'competing-attempt', idempotencyKey: 'competing-attempt', reservationId: 'competing-reservation' });
			const results = await Promise.allSettled([f.admit(), f.admit(), f.admit(f.input(other))]);
			expect(results.filter(value => value.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
			const state = await f.snapshot(); expect(state.financial.capacity_provider_assignments).toHaveLength(1);
			expect(state.financial.capacity_reservations).toHaveLength(1); expect(state.proxies).toHaveLength(1);
			expect(state.financial.capacity_reservation_counter_claims).toHaveLength(2);
			expect(state.financial.capacity_admission_counters).toEqual(expect.arrayContaining([expect.objectContaining({ hard_limit: 10, committed_amount: 4 })]));
		} finally { await f.db.close(); }
	});
	it('denies exhausted supply and concurrency without enlarging existing hard limits or original deadlines', async () => {
		const f = await initialAdmission(); try {
			await f.admit(); await f.query('UPDATE capacity_admission_counters SET committed_amount=11');
			const next = assignmentAttemptSchema.parse({ ...f.attempt, id: 'next', idempotencyKey: 'next', nodeId: 'next-node', reservationId: 'next-reservation' });
			await f.seedNode(next); const before = await f.snapshot();
			await expect(f.admit(f.input(next))).rejects.toThrow(); const after = await f.snapshot();
			expect(after.financial.capacity_reservations).toEqual(before.financial.capacity_reservations);
			expect(after.financial.capacity_provider_assignments).toEqual(before.financial.capacity_provider_assignments);
			expect(after.financial.capacity_admission_counters).toEqual(expect.arrayContaining([expect.objectContaining({ hard_limit: 10, committed_amount: 11 })]));
			expect(next.deadline).toBe(f.attempt.deadline);
		} finally { await f.db.close(); }
	});
	it('rolls back late native proxy failure and retries the same immutable admission without residue', async () => {
		const f = await initialAdmission(); try {
			await f.db.exec(`CREATE FUNCTION reject_proxy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated late proxy interruption'; END $$;
				CREATE TRIGGER reject_proxy BEFORE INSERT ON treedx_proxy_handles FOR EACH ROW EXECUTE FUNCTION reject_proxy();`);
			const input = f.input(), before = await f.snapshot(); await expect(f.admit(input)).rejects.toThrow('isolated late proxy interruption');
			expect(await f.snapshot()).toEqual(before);
			await f.db.exec('DROP TRIGGER reject_proxy ON treedx_proxy_handles; DROP FUNCTION reject_proxy();');
			await f.admit(input); const committed = await f.snapshot(); await f.admit(input);
			expect(await f.snapshot()).toEqual(committed); expect(committed.financial.capacity_reservations).toHaveLength(1);
		} finally { await f.db.close(); }
	});
	it('denies allocator mismatch malformed concurrency and expired productive windows before native writes', async () => {
		const f = await initialAdmission(); try {
			const before = await f.snapshot(), outcomes = [];
			for (const change of [
				(input: ReturnType<typeof f.input>) => { input.allocation.allocatedSeconds = 2; },
				(input: ReturnType<typeof f.input>) => { input.workdayConcurrencyLimit = 0; },
				(input: ReturnType<typeof f.input>) => { input.providerConcurrencyLimit = 1.5; },
				(input: ReturnType<typeof f.input>) => { input.now = input.assignment.deadline; },
			]) { const input = f.input(); change(input); outcomes.push(await f.admit(input).then(() => 'admitted', () => 'denied')); }
			expect(outcomes).toEqual(['denied', 'denied', 'denied', 'denied']); expect(await f.snapshot()).toEqual(before);
		} finally { await f.db.close(); }
	});
});
