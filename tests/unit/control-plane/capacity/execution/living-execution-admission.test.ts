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
			lanePurpose: 'workday', executionKind: 'workday', predecessorResults: [], treedxProxyHandle: { id: 'tdx_assignment', status: 'issued',
				allowedPaths: [], allowedReadPaths: [], allowedWritePaths: [], scopes: [], allowedOperations: [] }, now: assignment.createdAt })).resolves.toBe(committed);
		const sql = store.batch.mock.calls[0]![0].map((operation: { query: string }) => operation.query).join('\n');
		expect(sql).toMatch(/FOR UPDATE/u);
		expect(sql).toMatch(/prior\.status<>'returned'/u);
		expect(sql).toMatch(/capacity_reservations/u);
		expect(sql).toMatch(/committed_amount\+\?<=LEAST\(hard_limit,\?\)/u);
		expect(sql).toMatch(/INSERT INTO capacity_reservation_counter_claims/u);
		for (const operation of store.batch.mock.calls[0]![0]) {
			expect((operation.query.match(/\?/gu) ?? []).length).toBe(operation.params.length);
		}
		expect(sql).toMatch(/assignment_attempt_json/u);
		const explanation = store.batch.mock.calls[0]![0].find((operation: { query: string }) => operation.query.includes('SET explanation_json'))!;
		expect(JSON.parse(String(explanation.params[0]))).toMatchObject({ allocatedSeconds: 3, limitingConstraint: 'task-duration' });
		expect(sql).toMatch(/INSERT INTO treedx_proxy_handles/u);
		const assignmentInsert = store.batch.mock.calls[0]![0].find((operation: { query: string }) => operation.query.includes('INSERT INTO capacity_provider_assignments'))!;
		expect(assignmentInsert.query).toMatch(/SELECT (?:\?,){14}\?,'pending'/u);
		expect(assignmentInsert.params[14]).toBeNull();
		expect(JSON.parse(String(assignmentInsert.params[17]))).toMatchObject({ teamId: 'team', projectId: 'project', mode: 'acting',
			budget: { time: { executionSeconds: 3, requestedSeconds: 3 } } });
		expect(JSON.parse(String(assignmentInsert.params[18]))).toMatchObject({ teamId: 'team', projectId: 'project', mode: 'acting',
			metadata: { source: 'living_execution_graph', nodeId: 'node' } });
		expect(() => JSON.parse(String(assignmentInsert.params[24]))).not.toThrow();
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
			lanePurpose: 'workday', executionKind: 'workday', predecessorResults: [], treedxProxyHandle: {}, now: assignment.createdAt }))
			.rejects.toMatchObject({ code: 'assignment_allocation_mismatch' });
		expect(store.batch).not.toHaveBeenCalled();
	});

	it('refuses to re-admit a completed execution-node revision while permitting an explicit returned retry', async () => {
		const committed = { id: assignment.id, executionNodeId: 'node', executionNodeRevision: 1 };
		const store = { getProviderAssignment: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(committed), batch: vi.fn(async () => []) };
		await admitLivingExecutionAssignment(store as never, { principal: { teamId: 'team', capacityProviderId: 'provider', membershipId: 'membership' } as never,
			accountingLimits, assignment: assignment as never, allocation, projectAgentClassId: 'class', providerSessionId: 'session', executionProviderId: 'runtime', laneId: 'lane',
			lanePurpose: 'workday', executionKind: 'workday', predecessorResults: [], treedxProxyHandle: { id: 'tdx_assignment', status: 'issued',
				allowedPaths: [], allowedReadPaths: [], allowedWritePaths: [], scopes: [], allowedOperations: [] }, now: assignment.createdAt });
		const operations = store.batch.mock.calls[0]![0] as Array<{ query: string; params: unknown[] }>;
		const reservation = operations.find((operation) => operation.query.includes('INSERT INTO capacity_reservations'))!;
		const insertedAssignment = operations.find((operation) => operation.query.includes('INSERT INTO capacity_provider_assignments'))!;
		expect(reservation.query).toMatch(/prior\.execution_node_revision=node\.node_revision[\s\S]*prior\.status<>'returned'/u);
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
			lanePurpose: 'communication', executionKind: 'conversation', invocationId: 'invocation-1', predecessorResults: [], treedxProxyHandle: { id: 'tdx_assignment', status: 'issued',
				allowedPaths: [], allowedReadPaths: [], allowedWritePaths: [], scopes: [], allowedOperations: [] }, now: assignment.createdAt });
		const binding = store.batch.mock.calls[0]![0].find((operation: { query: string }) => operation.query.includes('UPDATE agent_invocation_requests'))!;
		expect(binding.params).toEqual(['assignment', assignment.createdAt, 'invocation-1', 'team', 'assignment']);
	});
});
