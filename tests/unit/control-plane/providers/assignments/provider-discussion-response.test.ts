import { describe, expect, it, vi } from 'vitest';
import { recordAssignmentDiscussionResponse } from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-discussion-response-service.ts';

const input = { assignmentId: 'assignment', invocationId: 'invocation', teamId: 'team', leaseToken: 'lease',
	messagePath: 'discussion-messages/response.mdx', outcome: 'responded' as const,
	reference: { kind: 'treedx' as const, projectId: 'project', repository: 'repo_project', commit: 'a'.repeat(40), path: 'discussion-messages/response.mdx', workspaceId: 'workspace' } };

describe('durable discussion publication retains canonical completion authority', () => {
	it('records the exact response without returning the assignment or revoking its lease', async () => {
		const batch = vi.fn().mockResolvedValue([]);
		await recordAssignmentDiscussionResponse({ batch, first: vi.fn().mockResolvedValue({ final_message_ref: input.messagePath }) } as never, input);
		const operations = batch.mock.calls[0]![0] as Array<{ query: string; params: unknown[] }>;
		expect(operations).toHaveLength(1);
		expect(operations[0]!.query).toContain("assignment.status='leased'");
		expect(operations[0]!.query).toContain("assignment.lease_token=?");
		expect(operations[0]!.query).not.toContain("status='returned'");
		expect(operations[0]!.query).not.toContain('UPDATE capacity_provider_assignments');
		expect(operations[0]!.params).toContain(JSON.stringify({ outcome: input.outcome, reference: input.reference }));
	});
	it('fails closed if concurrent lease loss prevents durable response attribution', async () => {
		await expect(recordAssignmentDiscussionResponse({ batch: vi.fn().mockResolvedValue([]), first: vi.fn().mockResolvedValue(null) } as never, input))
			.rejects.toMatchObject({ code: 'communication_response_record_failed' });
	});
});
