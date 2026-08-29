import { describe, expect, it, vi } from 'vitest';
import { reconcileTerminalConversationInvocations } from '../../../../../src/api/capacity/services/capacity/invocations/discussion-invocation-service.ts';

describe('terminal conversation invocation reconciliation', () => {
	it('fails a stale running invocation and publishes a visible lifecycle event', async () => {
		const invocation = {
			id: 'invocation-old', team_id: 'team-1', project_id: 'project-1', agent_id: 'architect',
			status: 'running', execution_kind: 'conversation', final_message_ref: null,
			metadata_json: { communication: { topicId: 'topic-1', sendId: 'send-1' } },
		};
		const run = vi.fn(async (query: string) => query.includes('UPDATE agent_invocation_requests') ? { changes: 1 } : { changes: 1 });
		const store = {
			all: vi.fn(async () => [invocation]),
			first: vi.fn(async (query: string) => {
				if (query.includes('capacity_provider_assignments')) return { id: 'assignment-1', status: 'returned', lifecycle_code: 'workday_deadline_elapsed', lifecycle_reason: 'Deadline elapsed.' };
				if (query.includes('FROM projects')) return { slug: 'sdk' };
				return null;
			}),
			run,
			createCapacityWorkdayRun: vi.fn(), tickCapacityWorkdayRun: vi.fn(), updateCapacityWorkdayRun: vi.fn(),
		};

		await expect(reconcileTerminalConversationInvocations(store, 'team-1')).resolves.toEqual({ reconciled: 1 });
		expect(run).toHaveBeenCalledWith(expect.stringContaining('UPDATE agent_invocation_requests'), expect.arrayContaining(['failed', 'assignment-1']));
		expect(run).toHaveBeenCalledWith(expect.stringContaining("'agent.failed'"), expect.arrayContaining(['@sdk/architect']));
	});
});
