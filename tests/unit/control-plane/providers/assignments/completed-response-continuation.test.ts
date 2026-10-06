import { describe, expect, it, vi } from 'vitest';
import { resolveDiscussionInvocationAgents } from '../../../../../src/api/capacity/services/capacity/invocations/discussion-invocation-service.ts';

const input = { teamId: 'team', projectId: 'project', discussionId: 'discussion', parentAssignmentId: 'parent', mentionedAgents: [] };
const completed = { agent_id: 'architect', status: 'completed', lease_state: 'released', execution_kind: 'conversation',
	final_message_ref: 'discussion-messages/response.mdx', metadata_json: JSON.stringify({ discussionId: 'discussion' }) };

describe('completed response continuation', () => {
	it('resumes the exact agent only after canonical completion and lease release', async () => {
		const first = vi.fn().mockResolvedValue(completed);
		await expect(resolveDiscussionInvocationAgents({ first } as never, input)).resolves.toEqual(['architect']);
		expect(first.mock.calls[0]![1]).toEqual(['parent', 'team', 'project']);
	});
	it.each([
		{ status: 'returned' }, { status: 'leased' }, { lease_state: 'active' },
		{ execution_kind: 'workday' }, { final_message_ref: '' }, { metadata_json: { discussionId: 'other' } },
	])('rejects incomplete or unrelated parent authority: %j', async (change) => {
		await expect(resolveDiscussionInvocationAgents({ first: vi.fn().mockResolvedValue({ ...completed, ...change }) } as never, input))
			.rejects.toMatchObject({ code: 'discussion_continuation_parent_invalid' });
	});
	it('does not override explicit addressed agents', async () => {
		const first = vi.fn();
		await expect(resolveDiscussionInvocationAgents({ first } as never, { ...input, mentionedAgents: ['tester'] })).resolves.toEqual(['tester']);
		expect(first).not.toHaveBeenCalled();
	});
});
