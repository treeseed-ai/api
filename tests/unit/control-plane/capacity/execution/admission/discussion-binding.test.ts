import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { calculateAssignmentAllocation } from '@treeseed/sdk/agent-capacity';
import { admitLivingExecutionAssignment } from '../../../../../../src/api/capacity/services/capacity/assignments/admission/living-execution-admission.ts';
import { assignment } from '../fixtures/assignment.ts';

async function bindingOperation(attemptId: string = assignment.id) {
	const attempt = { ...assignment, id: attemptId };
	let operations: Array<{ query: string; params: unknown[] }> = [];
	const committed = { id: attempt.id, executionNodeId: attempt.nodeId, executionNodeRevision: attempt.nodeRevision };
	const store = { getProviderAssignment: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(committed),
		batch: async (batch: typeof operations) => { operations = batch; } };
	await admitLivingExecutionAssignment(store as never, {
		principal: { teamId: 'team', capacityProviderId: 'provider', membershipId: 'membership' } as never,
		assignment: attempt as never,
		allocation: { ...calculateAssignmentAllocation({ estimate: assignment.estimate, measurements: [],
			constraints: [{ id: 'execution-window', remainingSeconds: 180 }] }), opportunity: { phase: 'planning' } } as never,
		accountingLimits: { modelConfigurationId: 'terra-medium', dailyActiveSecondsLimit: 28800,
			capabilityLimits: { 'code-change': { dailyActiveSecondsLimit: 28800 } } },
		projectAgentClassId: 'class', providerSessionId: 'session', executionProviderId: 'runtime',
		laneId: 'communication', lanePurpose: 'communication', executionKind: 'conversation',
		workdayConcurrencyLimit: 5, invocationId: 'invocation', predecessorResults: [],
		treedxProxyHandle: { id: 'tdx_assignment' }, now: assignment.createdAt,
	});
	return operations.find(operation => operation.query.includes('UPDATE agent_invocation_requests'))!;
}

describe('conversation admission binding in PostgreSQL', () => {
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
