import { describe, expect, it, vi } from 'vitest';
import { closeSuspendedConversationExecution, suspendAssignmentForDiscussionResponse } from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-discussion-suspension-service.ts';

describe('provider discussion suspension', () => {
	it('atomically suspends the assignment and invocation before exposing a returned assignment', async () => {
		const suspended = {
			id: 'assignment-1', teamId: 'team-1', invocationId: 'invocation-1', status: 'returned', leaseState: 'released',
			metadata: { operationalState: 'suspended', waitingMessageId: 'message-1' },
		};
		const batch = vi.fn().mockResolvedValue([]);
		const store = {
			getProviderAssignment: vi.fn()
				.mockResolvedValueOnce({ ...suspended, status: 'leased', leaseState: 'leased', leaseToken: 'lease-1', metadata: {} })
				.mockResolvedValueOnce(suspended),
			batch,
		} as never;

		await expect(suspendAssignmentForDiscussionResponse(store, {
			assignmentId: 'assignment-1', teamId: 'team-1', leaseToken: 'lease-1', discussionId: 'discussion-1',
			messageId: 'message-1', message: 'Done.', messagePath: 'discussion-messages/response.mdx', checkpoint: {},
		})).resolves.toEqual(suspended);
		const operations = batch.mock.calls[0]![0] as Array<{ query: string }>;
		expect(operations[0]!.query).toContain("SET status='returned'");
		expect(operations.at(-1)!.query).toContain("SET status='suspended'");
		expect(operations.at(-1)!.query).toContain("assignment.status='returned'");
	});

	it('closes the exact conversation workday without a demand lookup', async () => {
		const batch = vi.fn(async (_operations: unknown[]) => []);
		const first = vi.fn().mockResolvedValueOnce({ final_message_ref: 'discussion-messages/response.mdx' })
			.mockResolvedValueOnce({ parameters_json: JSON.stringify({ appliedPlan: { schemaVersion: 'treeseed.workday/v1', state: 'active' } }), execution_kind: 'conversation', status: 'running' })
			.mockResolvedValueOnce({ status: 'completed' });
		await closeSuspendedConversationExecution({ first, batch } as never, {
			id: 'assignment-1', teamId: 'team-1', invocationId: 'invocation-1', workDayId: 'conversation-1',
		} as never);
		const operations = batch.mock.calls[0]![0] as unknown as Array<{ query: string; params: unknown[] }>;
		expect(operations.map((entry) => entry.query).join('\n')).not.toContain('capacity_workday_demands');
		expect(operations[0]!.query).toContain("status='completed'");
		expect(operations[0]!.params[0]).toContain('"state":"ended"');
		expect(operations[0]!.params[1]).toContain('required_response_completed');
		expect(operations.every((entry) => entry.params.includes('conversation-1'))).toBe(true);
	});

	it('completes a communication node without ending its parent workday', async () => {
		const batch = vi.fn(async (_operations: unknown[]) => []);
		const first = vi.fn()
			.mockResolvedValueOnce({ final_message_ref: 'discussion-messages/response.mdx' })
			.mockResolvedValueOnce({
				parameters_json: JSON.stringify({ appliedPlan: { schemaVersion: 'treeseed.workday/v1', state: 'active' } }),
				execution_kind: 'workday', status: 'running',
			})
			.mockResolvedValueOnce({ revision: 4 });
		const all = vi.fn()
			.mockResolvedValueOnce([{ id: 'communication:invocation-1:workday-1', node_revision: 1, status: 'assigned',
				schema_version: 'treeseed.execution-node/v1', team_id: 'team-1', project_id: 'project-1', workday_id: 'workday-1',
				kind: 'communication', pair_role: null, source_ref_json: JSON.stringify({ store: 'treedx', model: 'discussion', id: 'invocation-1', revision: 1, digest: `sha256:${'a'.repeat(64)}` }), authority_refs_json: '[]', rule_revision: 1,
				agent_class: 'reporter', estimate_json: '{"minimumSeconds":1,"expectedSeconds":4,"maximumSeconds":4}',
				required_capabilities_json: '[]', requested_permissions_json: JSON.stringify({ content: { read: [], write: [] }, tools: [] }), workspace: 'treedx', acceptance_criteria_json: JSON.stringify(['Return one response.']),
				graph_revision_created: 4, graph_revision_updated: 4, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }])
			.mockResolvedValueOnce([]);
		await expect(closeSuspendedConversationExecution({ first, all, batch } as never, {
			id: 'assignment-1', teamId: 'team-1', invocationId: 'invocation-1', workDayId: 'workday-1',
			executionNodeId: 'communication:invocation-1:workday-1', executionNodeRevision: 1,
		} as never)).resolves.toEqual({ status: 'running', completed_at: null });
		const operations = batch.mock.calls[0]![0] as unknown as Array<{ query: string; params: unknown[] }>;
		expect(operations.some((entry) => entry.query.includes('UPDATE capacity_workday_runs'))).toBe(false);
		expect(operations.some((entry) => entry.query.includes('UPDATE execution_nodes SET status=?')
			&& entry.params[0] === 'completed')).toBe(true);
	});
});
