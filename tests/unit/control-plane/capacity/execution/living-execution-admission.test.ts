import { describe, expect, it, vi } from 'vitest';
import { admitLivingExecutionAssignment } from '../../../../../src/api/capacity/services/capacity/assignments/admission/living-execution-admission.ts';
import { calculateAssignmentAllocation } from '@treeseed/sdk/agent-capacity';

import { assignment } from './fixtures/assignment.ts';
const allocation = calculateAssignmentAllocation({ estimate: assignment.estimate, measurements: [],
	constraints: [{ id: 'execution-window', remainingSeconds: 180 }] });
const accountingLimits = { modelConfigurationId: 'terra-medium', dailyActiveSecondsLimit: 28800,
	capabilityLimits: { 'code-change': { dailyActiveSecondsLimit: 28800 } } };

describe('living execution admission', () => {
	it('claims the node, reservation, and immutable attempt in one batch without legacy demand/allocation authority', async () => {
		const committed = { id: assignment.id, executionNodeId: 'node', executionNodeRevision: 1 };
		const store = { getProviderAssignment: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(committed), batch: vi.fn(async () => []) };
		await expect(admitLivingExecutionAssignment(store as never, { principal: { teamId: 'team', capacityProviderId: 'provider', membershipId: 'membership' } as never,
			accountingLimits, assignment: assignment as never, allocation, projectAgentClassId: 'class', providerSessionId: 'session', executionProviderId: 'runtime', laneId: 'lane',
			lanePurpose: 'workday', executionKind: 'workday', workdayConcurrencyLimit: 1, predecessorResults: [], treedxProxyHandle: { id: 'tdx_assignment', status: 'issued',
				allowedPaths: [], allowedReadPaths: [], allowedWritePaths: [], scopes: [], allowedOperations: [] }, now: assignment.createdAt })).resolves.toBe(committed);
		const sql = store.batch.mock.calls[0]![0].map((operation: { query: string }) => operation.query).join('\n');
		expect(sql).toMatch(/FOR UPDATE/u);
		expect(sql).toMatch(/capacity_workday_runs WHERE team_id=\? AND id=\? AND status='running' FOR UPDATE/u);
		expect(sql).toMatch(/active\.execution_kind=\?[\s\S]*active\.status IN \('pending','leased','running'\)\) < \?/u);
		expect(sql).toMatch(/prior\.status<>'returned'/u);
		expect(sql).toMatch(/review_pair\.provenance='review-pair'/u);
		expect(sql).toMatch(/reviewDisposition\}'='request-changes'/u);
		expect(sql).toMatch(/>=COALESCE\(reviewer\.maximum_review_cycles,1\)/u);
		expect(sql).toMatch(/capacity_reservations/u);
		expect(sql).toMatch(/committed_amount\+\?<=LEAST\(hard_limit,\?\)/u);
		expect(sql).toMatch(/ON CONFLICT \(id\) DO UPDATE\s+SET hard_limit=EXCLUDED.hard_limit/u);
		expect(sql).toMatch(/INSERT INTO capacity_reservation_counter_claims/u);
		for (const operation of store.batch.mock.calls[0]![0]) {
			expect((operation.query.match(/\?/gu) ?? []).length).toBe(operation.params.length);
		}
		expect(sql).toMatch(/assignment_attempt_json/u);
		const explanation = store.batch.mock.calls[0]![0].find((operation: { query: string }) => operation.query.includes('SET explanation_json'))!;
		expect(JSON.parse(String(explanation.params[0]))).toMatchObject({ metadata: { allocation: { allocatedSeconds: 3, limitingConstraint: 'task-duration' } } });
		expect(sql).toMatch(/INSERT INTO treedx_proxy_handles/u);
		const assignmentInsert = store.batch.mock.calls[0]![0].find((operation: { query: string }) => operation.query.includes('INSERT INTO capacity_provider_assignments'))!;
		expect(assignmentInsert.query).toMatch(/SELECT (?:\?,){14}\?,'pending'/u);
		expect(assignmentInsert.params[14]).toBeNull();
		expect(JSON.parse(String(assignmentInsert.params[17]))).toMatchObject({ teamId: 'team', projectId: 'project', mode: 'acting',
			budget: { time: { executionSeconds: 3, requestedSeconds: 3 } } });
		expect(JSON.parse(String(assignmentInsert.params[18]))).toMatchObject({ assignmentAttempt: {
			teamId: 'team', projectId: 'project', nodeId: 'node', effectiveProfile: { activity: 'acting' } },
			predecessorResults: [] });
		expect(assignmentInsert.query).not.toContain('decision_input_json');
		expect(store.batch.mock.calls[0]![0].some((operation: { params: unknown[] }) => operation.params.includes('workday'))).toBe(true);
		expect(store.batch.mock.calls[0]![0].some((operation: { params: unknown[] }) => operation.params.includes('operation'))).toBe(false);
		expect(sql).not.toMatch(/'workday',\?,\?,\?,\?,'pending'/u);
		expect(sql).not.toMatch(/capacity_workday_demands|capacity_allocation_sets|agent_capacity_plans/u);
	});

	it('rejects assignment duration changes after allocator sizing without writing a reservation', async () => {
		const store = { getProviderAssignment: vi.fn().mockResolvedValue(null), batch: vi.fn() };
		await expect(admitLivingExecutionAssignment(store as never, { principal: {} as never,
			accountingLimits, assignment: assignment as never, allocation: { ...allocation, allocatedSeconds: 2 },
			projectAgentClassId: 'class', providerSessionId: 'session', executionProviderId: 'runtime', laneId: 'lane',
			lanePurpose: 'workday', executionKind: 'workday', workdayConcurrencyLimit: 1, predecessorResults: [], treedxProxyHandle: {}, now: assignment.createdAt }))
			.rejects.toMatchObject({ code: 'assignment_allocation_mismatch' });
		expect(store.batch).not.toHaveBeenCalled();
	});

	it('explains a workday lane race rather than misreporting a lost graph node', async () => {
		const store = { getProviderAssignment: vi.fn().mockResolvedValue(null), batch: vi.fn(async () => []),
			first: vi.fn(async () => ({ active_count: 1 })) };
		await expect(admitLivingExecutionAssignment(store as never, { principal: { teamId: 'team', capacityProviderId: 'provider', membershipId: 'membership' } as never,
			accountingLimits, assignment: assignment as never, allocation, projectAgentClassId: 'class', providerSessionId: 'session', executionProviderId: 'runtime', laneId: 'lane',
			lanePurpose: 'workday', executionKind: 'workday', workdayConcurrencyLimit: 1, predecessorResults: [],
			treedxProxyHandle: { id: 'tdx_assignment' }, now: assignment.createdAt }))
			.rejects.toMatchObject({ code: 'capacity_assignment_allocation_deferred', details: {
				reason: 'workday_concurrency_exhausted', executionKind: 'workday', limit: 1 } });
		expect(store.first.mock.calls[0]?.[1]).toEqual(['team', 'workday', 'workday']);
	});

	it('refuses to re-admit a completed execution-node revision while permitting an explicit returned retry', async () => {
		const committed = { id: assignment.id, executionNodeId: 'node', executionNodeRevision: 1 };
		const store = { getProviderAssignment: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(committed), batch: vi.fn(async () => []) };
		await admitLivingExecutionAssignment(store as never, { principal: { teamId: 'team', capacityProviderId: 'provider', membershipId: 'membership' } as never,
			accountingLimits, assignment: assignment as never, allocation, projectAgentClassId: 'class', providerSessionId: 'session', executionProviderId: 'runtime', laneId: 'lane',
			lanePurpose: 'workday', executionKind: 'workday', workdayConcurrencyLimit: 1, predecessorResults: [], treedxProxyHandle: { id: 'tdx_assignment', status: 'issued',
				allowedPaths: [], allowedReadPaths: [], allowedWritePaths: [], scopes: [], allowedOperations: [] }, now: assignment.createdAt });
		const operations = store.batch.mock.calls[0]![0] as Array<{ query: string; params: unknown[] }>;
		const reservation = operations.find((operation) => operation.query.includes('INSERT INTO capacity_reservations'))!;
		expect(reservation.params.slice(-8)).toEqual(['team', 'workday', 'workday', 1, 'team', 'provider', 'lane', 1]);
		const insertedAssignment = operations.find((operation) => operation.query.includes('INSERT INTO capacity_provider_assignments'))!;
		expect(reservation.query).toMatch(/prior\.execution_node_revision=node\.node_revision[\s\S]*prior\.status<>'returned'/u);
		expect(reservation.query).toContain('node.workday_id IS NULL OR review_history.work_day_id=node.workday_id');
		expect(insertedAssignment.query).toMatch(/prior\.execution_node_revision=\?[\s\S]*prior\.status<>'returned'/u);
		expect(reservation.query).toMatch(/prior\.execution_kind='conversation'[\s\S]*prior\.lifecycle_code='discussion_response_required'/u);
		expect(insertedAssignment.query).toMatch(/prior\.execution_kind='conversation'[\s\S]*prior\.lifecycle_code='discussion_response_required'/u);
		expect(insertedAssignment.params.slice(-3)).toEqual(['team', 'node', 1]);
	});

	it('binds a conversation invocation to the assignment in the admission transaction', async () => {
		const committed = { id: assignment.id, executionNodeId: 'node', executionNodeRevision: 1 };
		const store = { getProviderAssignment: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(committed), batch: vi.fn(async () => []) };
		await admitLivingExecutionAssignment(store as never, { principal: { teamId: 'team', capacityProviderId: 'provider', membershipId: 'membership' } as never,
			accountingLimits, assignment: assignment as never, allocation, projectAgentClassId: 'class', providerSessionId: 'session', executionProviderId: 'runtime', laneId: 'communication',
			lanePurpose: 'communication', executionKind: 'conversation', workdayConcurrencyLimit: 2, invocationId: 'invocation-1', predecessorResults: [], treedxProxyHandle: { id: 'tdx_assignment', status: 'issued',
				allowedPaths: [], allowedReadPaths: [], allowedWritePaths: [], scopes: [], allowedOperations: [] }, now: assignment.createdAt });
		const binding = store.batch.mock.calls[0]![0].find((operation: { query: string }) => operation.query.includes('UPDATE agent_invocation_requests'))!;
		expect(binding.params).toEqual(['assignment', assignment.createdAt, 'invocation-1', 'team', 'assignment']);
		const reservation = store.batch.mock.calls[0]![0].find((operation: { query: string }) => operation.query.includes('INSERT INTO capacity_reservations'))!;
		expect(reservation.params.slice(-8)).toEqual(['team', 'workday', 'conversation', 2, 'team', 'provider', 'communication', 1]);
	});
});
