import { describe, expect, it } from 'vitest';
import { closeoutDatabase } from '../graph/architecture/closeout-sql-fixture.ts';
import { ProviderAssignmentRepository } from '../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import type { CapacityGovernanceDatabase } from '../../../../../../src/api/capacity/database.ts';
import { admitLivingExecutionAssignment } from '../../../../../../src/api/capacity/services/capacity/assignments/admission/living-execution-admission.ts';
import { replayAttempt, replayChanges, replayInput } from './admission-replay-fixture.ts';

// REAL original-DDL PGlite + owning repository + admission boundary. This tests
// replay of persisted custody, not initial claim/server concurrency or live supply.
async function nativeReplay() {
	const fixture = await closeoutDatabase(), attempt = replayAttempt();
	try {
		await fixture.query(`INSERT INTO capacity_provider_assignments (id,membership_id,team_id,project_id,capacity_provider_id,
			project_agent_class_id,work_day_id,mode,status,lease_state,execution_node_id,execution_node_revision,graph_revision,
			assignment_attempt_json,capacity_envelope_json,created_at,updated_at,execution_provider_id,reservation_id,attempt_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			[attempt.id, 'membership', attempt.teamId, attempt.projectId, 'provider', 'configured-builder', 'workday', 'acting', 'pending',
				'unleased', attempt.nodeId, attempt.nodeRevision, attempt.graphRevision, JSON.stringify(attempt), JSON.stringify({
					teamId: attempt.teamId, projectId: attempt.projectId, mode: 'acting', requestedSeconds: attempt.limits.maximumSeconds,
					reservedSeconds: attempt.limits.maximumSeconds, workDayId: attempt.workdayId, capacityProviderId: attempt.provider.providerId,
					executionProviderId: attempt.provider.executionProviderId, reservationId: attempt.reservationId, projectAgentClassId: 'configured-builder' }),
				attempt.createdAt, attempt.createdAt, attempt.provider.executionProviderId, attempt.reservationId, attempt.attempt]);
		const repository = new ProviderAssignmentRepository(fixture.store as unknown as CapacityGovernanceDatabase);
		// Establish valid stored custody before any denial assertion. A corrupt fixture
		// must not masquerade as rejection of the tested replay authority change.
		expect((await repository.get('team', attempt.id))?.assignmentAttempt).toEqual(attempt);
		const store = { ...fixture.store, getProviderAssignment: (team: string, id: string) => repository.get(team, id) };
		const snapshot = async () => {
			const result: Record<string, unknown> = {};
			for (const table of ['capacity_provider_assignments', 'capacity_reservations', 'capacity_workday_runs', 'execution_nodes', 'execution_edges', 'audit_events']) {
				result[table] = (await fixture.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
			}
			return result;
		};
		return { ...fixture, repository, snapshot, store: store as unknown as Parameters<typeof admitLivingExecutionAssignment>[0] };
	} catch (error) { await fixture.db.close(); throw error; }
}

describe('native immutable admission replay', () => {
	it('replays exact persisted custody repeatedly and concurrently without changing six owning SQL tables', async () => {
		const fixture = await nativeReplay();
		try {
			const input = replayInput(replayAttempt()), before = await fixture.snapshot(), original = structuredClone(input);
			const stored = await fixture.repository.get('team', input.assignment.id);
			expect(stored?.assignmentAttempt).toEqual(input.assignment);
			const run = () => admitLivingExecutionAssignment(fixture.store, input);
			await expect(run()).resolves.toEqual(stored);
			expect(await Promise.all([run(), run()])).toEqual([stored, stored]);
			expect(await fixture.snapshot()).toEqual(before); expect(input).toEqual(original);
		} finally { await fixture.db.close(); }
	});
	for (const { name, change } of replayChanges) it(`denies changed ${name} against actual stored custody`, async () => {
		const fixture = await nativeReplay();
		try {
			const value = replayAttempt(); change(value); const input = replayInput(value), before = await fixture.snapshot(), original = structuredClone(input);
			const outcome = await admitLivingExecutionAssignment(fixture.store, input).then(value => ({ value }), error => ({ error }));
			expect(await fixture.snapshot()).toEqual(before); expect(input).toEqual(original);
			expect('error' in outcome, `Changed ${name} must not be admitted`).toBe(true);
		} finally { await fixture.db.close(); }
	});
	it('denies unrelated authenticated team and provider while preserving persisted authority', async () => {
		const fixture = await nativeReplay();
		try {
			const before = await fixture.snapshot(), outcomes = [];
			for (const principal of [{ teamId: 'other-team' }, { capacityProviderId: 'other-provider' }]) {
				const input = replayInput(replayAttempt()); Object.assign(input.principal, principal);
				outcomes.push(await admitLivingExecutionAssignment(fixture.store, input).then(value => ({ value }), error => ({ error })));
			}
			expect(await fixture.snapshot()).toEqual(before);
			expect(outcomes.every(outcome => 'error' in outcome), 'Both unrelated principals must be denied').toBe(true);
		} finally { await fixture.db.close(); }
	});
});
