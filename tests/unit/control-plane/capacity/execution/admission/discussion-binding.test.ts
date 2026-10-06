import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { assignmentAttemptSchema, calculateAssignmentAllocation } from '@treeseed/sdk/agent-capacity';
import { admitLivingExecutionAssignment } from '../../../../../../src/api/capacity/services/capacity/assignments/admission/living-execution-admission.ts';
import { serializeProviderAssignmentRow } from '../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import { assignment } from '../fixtures/assignment.ts';

async function admissionOperations(attemptId: string = assignment.id) {
	const attempt = assignmentAttemptSchema.parse({ ...structuredClone(assignment), id: attemptId });
	let operations: Array<{ query: string; params: unknown[] }> = [];
	const committed = serializeProviderAssignmentRow({ id: attempt.id, membership_id: 'membership', team_id: attempt.teamId,
		project_id: attempt.projectId, capacity_provider_id: attempt.provider.providerId, project_agent_class_id: 'class',
		mode: 'acting', status: 'pending', lease_state: 'unleased', work_day_id: attempt.workdayId,
		execution_provider_id: attempt.provider.executionProviderId, reservation_id: attempt.reservationId,
		attempt_count: attempt.attempt, graph_revision: attempt.graphRevision, agent_id: attempt.agentClass,
		execution_node_id: attempt.nodeId, execution_node_revision: attempt.nodeRevision, assignment_attempt_json: attempt,
		capacity_envelope_json: { teamId: attempt.teamId, projectId: attempt.projectId, mode: 'acting',
			requestedSeconds: 3, reservedSeconds: 3, workDayId: attempt.workdayId, capacityProviderId: attempt.provider.providerId,
			executionProviderId: attempt.provider.executionProviderId, reservationId: attempt.reservationId, projectAgentClassId: 'class' },
		created_at: attempt.createdAt, updated_at: attempt.createdAt });
	const store = { getProviderAssignment: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(committed),
		batch: async (batch: typeof operations) => { operations = batch; },
		first: vi.fn(async () => ({ id: attempt.nodeId, status: 'running', assignment_id: attempt.id })) };
	await admitLivingExecutionAssignment(store as never, {
		principal: { teamId: 'team', capacityProviderId: 'provider', membershipId: 'membership' } as never,
		assignment: attempt,
		allocation: { ...calculateAssignmentAllocation({ estimate: assignment.estimate, measurements: [],
			constraints: [{ id: 'execution-window', remainingSeconds: 180 }] }), opportunity: { phase: 'planning' } } as never,
		accountingLimits: { modelConfigurationId: 'terra-medium', dailyActiveSecondsLimit: 28800,
			capabilityLimits: { 'code-change': { dailyActiveSecondsLimit: 28800 } } },
		projectAgentClassId: 'class', providerSessionId: 'session', executionProviderId: attempt.provider.executionProviderId,
		laneId: 'communication', lanePurpose: 'communication', executionKind: 'conversation',
		workdayConcurrencyLimit: 5, invocationId: 'invocation', predecessorResults: [],
		treedxProxyHandle: { id: 'tdx_assignment' }, now: assignment.createdAt,
	});
	return operations;
}

async function bindingOperation(attemptId: string = assignment.id) {
	return (await admissionOperations(attemptId)).find(operation => operation.query.includes('UPDATE agent_invocation_requests'))!;
}

describe('conversation admission binding in PostgreSQL', () => {
	it.each(['returned', 'failed', 'cancelled', 'foreign-team', 'foreign-invocation', 'leased'])('rebinds only its own terminal conversation attempt: %s', async (scenario) => {
		const db = new PGlite();
		try {
			await db.exec(`CREATE TABLE agent_invocation_requests (id text,team_id text,assignment_id text,status text,updated_at text);
				CREATE TABLE capacity_provider_assignments (id text,team_id text,reservation_id text,invocation_id text,status text);
				INSERT INTO agent_invocation_requests VALUES ('invocation','team','prior','running',NULL);`);
			await db.query('INSERT INTO capacity_provider_assignments VALUES ($1,$2,$3,$4,$5)', ['prior',
				scenario === 'foreign-team' ? 'foreign' : 'team', 'prior-reservation',
				scenario === 'foreign-invocation' ? 'foreign' : 'invocation',
				scenario.startsWith('foreign-') ? 'failed' : scenario]);
			await db.query(`INSERT INTO capacity_provider_assignments VALUES ($1,'team',$2,'invocation','pending')`,
				[assignment.id, assignment.reservationId]);
			const candidate = (await db.query('SELECT * FROM capacity_provider_assignments ORDER BY id')).rows;
			const operation = await bindingOperation(); let index = 0;
			await db.query(operation.query.replace(/\?/gu, () => `$${++index}`), operation.params);
			await db.query(operation.query.replace(/\?/gu, (() => { let position = 0; return () => `$${++position}`; })()), operation.params);
			expect((await db.query('SELECT assignment_id,status FROM agent_invocation_requests')).rows).toEqual([
				{ assignment_id: ['returned', 'failed', 'cancelled'].includes(scenario) ? assignment.id : 'prior', status: 'running' },
			]);
			expect((await db.query('SELECT * FROM capacity_provider_assignments ORDER BY id')).rows).toEqual(candidate);
		} finally { await db.close(); }
	});
	it.each(['leased', 'pending', 'completed'])('preserves source custody when a losing admission reaches an existing %s assignment', async (status) => {
		const db = new PGlite();
		try {
			await db.exec(`CREATE TABLE capacity_provider_assignments (id text,team_id text,reservation_id text,status text,lease_state text,
				explanation_json jsonb,graph_revision integer,execution_node_id text,execution_node_revision integer,
				assignment_attempt_json jsonb,treedx_proxy_handle_json jsonb,workspace_context_json jsonb,updated_at text);
				CREATE TABLE capacity_reservations (id text,team_id text,assignment_id text,admission_token text);`);
			const pin = { schemaVersion: 'treeseed.assignment-source-pin/v1', exactCommit: 'a'.repeat(40) };
			const context = { sourceWorkspace: pin, predecessorResults: ['retained'], treedxProxyHandle: { id: 'winner' } };
			await db.query(`INSERT INTO capacity_provider_assignments
				(id,team_id,reservation_id,status,lease_state,workspace_context_json,treedx_proxy_handle_json)
				VALUES ($1,'team',$2,$3,$4,$5,'{"id":"winner"}')`,
				[assignment.id, assignment.reservationId, status, status === 'leased' ? 'leased' : 'unleased', JSON.stringify(context)]);
			await db.query(`INSERT INTO capacity_reservations VALUES ($1,'team',$2,'other-admission')`, [assignment.reservationId, assignment.id]);
			const operations = await admissionOperations();
			const update = operations.find(operation => operation.query.includes('SET explanation_json'))!;
			let index = 0;
			await db.query(update.query.replace(/\?/gu, () => `$${++index}`), update.params);
			expect((await db.query('SELECT workspace_context_json,treedx_proxy_handle_json FROM capacity_provider_assignments')).rows)
				.toEqual([{ workspace_context_json: context, treedx_proxy_handle_json: { id: 'winner' } }]);
			// Only the reservation token generated by this exact batch can initialize
			// the winning pending/unleased assignment; status alone is insufficient.
			if (status === 'pending') {
				const claim = operations.find(operation => operation.query.includes('INSERT INTO capacity_reservation_counter_claims'))!;
				const token = claim.params[2];
				await db.query('UPDATE capacity_reservations SET admission_token=$1', [token]);
				index = 0;
				await db.query(update.query.replace(/\?/gu, () => `$${++index}`), update.params);
				expect((await db.query<{ workspace_context_json: unknown }>('SELECT workspace_context_json FROM capacity_provider_assignments')).rows[0]?.workspace_context_json)
					.toMatchObject({ assignmentAttempt: { id: assignment.id }, predecessorResults: [] });
			}
		} finally { await db.close(); }
	}, 15_000);

	it('does not let a denied admission steal the invocation before the winning assignment exists', async () => {
		const db = new PGlite();
		try {
			await db.exec(`CREATE TABLE agent_invocation_requests (id text,team_id text,assignment_id text,status text,updated_at text);
				CREATE TABLE capacity_provider_assignments (id text,team_id text,reservation_id text,invocation_id text,status text);
				INSERT INTO agent_invocation_requests VALUES ('invocation','team',NULL,'admitted',NULL);`);
			const operation = await bindingOperation();
			let index = 0;
			const sql = operation.query.replace(/\?/gu, () => `$${++index}`);
			// Admission denied by the live concurrency guard: no assignment INSERT.
			const denied = await bindingOperation('denied-attempt'); index = 0;
			await db.query(denied.query.replace(/\?/gu, () => `$${++index}`), denied.params);
			expect((await db.query('SELECT assignment_id,status FROM agent_invocation_requests')).rows)
				.toEqual([{ assignment_id: null, status: 'admitted' }]);
			// A later successful admission binds only its committed immutable attempt.
			await db.query(`INSERT INTO capacity_provider_assignments VALUES ($1,'team',$2,'invocation','pending')`,
				[assignment.id, assignment.reservationId]);
			await db.query(sql, operation.params);
			await db.query(sql, operation.params);
			expect((await db.query('SELECT assignment_id,status FROM agent_invocation_requests')).rows)
				.toEqual([{ assignment_id: assignment.id, status: 'running' }]);
		} finally { await db.close(); }
	});

	it.each(['foreign-team', 'wrong-reservation', 'wrong-invocation', 'terminal', 'bound-other'])('rejects mismatched conversation admission authority: %s', async (scenario) => {
		const db = new PGlite();
		try {
			await db.exec(`CREATE TABLE agent_invocation_requests (id text,team_id text,assignment_id text,status text,updated_at text);
				CREATE TABLE capacity_provider_assignments (id text,team_id text,reservation_id text,invocation_id text,status text);`);
			const prior = scenario === 'bound-other' ? 'other-assignment' : null;
			await db.query(`INSERT INTO agent_invocation_requests VALUES ('invocation','team',$1,'admitted',NULL)`, [prior]);
			await db.query('INSERT INTO capacity_provider_assignments VALUES ($1,$2,$3,$4,$5)', [assignment.id,
				scenario === 'foreign-team' ? 'other-team' : 'team', scenario === 'wrong-reservation' ? 'other' : assignment.reservationId,
				scenario === 'wrong-invocation' ? 'other' : 'invocation', scenario === 'terminal' ? 'failed' : 'pending']);
			const operation = await bindingOperation(); let index = 0;
			await db.query(operation.query.replace(/\?/gu, () => `$${++index}`), operation.params);
			expect((await db.query('SELECT assignment_id,status FROM agent_invocation_requests')).rows)
				.toEqual([{ assignment_id: prior, status: 'admitted' }]);
		} finally { await db.close(); }
	});
});
