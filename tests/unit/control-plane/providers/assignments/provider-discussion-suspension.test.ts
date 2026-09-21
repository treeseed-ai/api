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
			.mockResolvedValueOnce({ status: 'degraded' });
		await closeSuspendedConversationExecution({ first, batch } as never, {
			id: 'assignment-1', teamId: 'team-1', invocationId: 'invocation-1', workDayId: 'conversation-1',
		} as never);
		const operations = batch.mock.calls[0]![0] as unknown as Array<{ query: string; params: unknown[] }>;
		expect(operations.map((entry) => entry.query).join('\n')).not.toContain('capacity_workday_demands');
		expect(operations.every((entry) => entry.params.includes('conversation-1'))).toBe(true);
	});
});
