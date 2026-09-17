import { describe, expect, it, vi } from 'vitest';
import { terminalizeCompletedConversationInvocation } from '../../../../../src/api/capacity/services/capacity/invocations/discussion-invocation-service.ts';

describe('workday-owned communication settlement', () => {
	it('keeps the parent workday alive after a durable communication response', async () => {
		const first = vi.fn(async (sql: string) => sql.includes('agent_invocation_requests')
			? { status: 'completed', execution_id: 'workday', assignment_id: 'chat', integration_ready: true }
			: { status: 'running', execution_kind: 'workday' });
		const store = { first, run: vi.fn(), updateCapacityWorkdayRun: vi.fn() };
		expect(await terminalizeCompletedConversationInvocation(store, 'team', 'invocation'))
			.toEqual({ terminalized: false, reason: 'parent_workday_retained', executionId: 'workday' });
		expect(first.mock.calls[1]?.[0]).toContain('id=? AND team_id=?');
		expect(store.run).not.toHaveBeenCalled();
		expect(store.updateCapacityWorkdayRun).not.toHaveBeenCalled();
	});
	it('does not finish a conversation before its content is integrated', async () => {
		const store = { first: vi.fn(async () => ({ status: 'completed', execution_id: 'conversation', integration_ready: false })), run: vi.fn(), updateCapacityWorkdayRun: vi.fn() };
		expect(await terminalizeCompletedConversationInvocation(store, 'team', 'invocation'))
			.toEqual({ terminalized: false, reason: 'content_integration_pending' });
		expect(store.updateCapacityWorkdayRun).not.toHaveBeenCalled();
	});
});
