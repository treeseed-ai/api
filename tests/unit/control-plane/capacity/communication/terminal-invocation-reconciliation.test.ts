import { describe, expect, it, vi } from 'vitest';
import { reconcileTerminalConversationInvocations } from '../../../../../src/api/capacity/services/capacity/invocations/discussion-invocation-service.ts';

describe('terminal conversation invocation reconciliation', () => {
	it('waits for content integration after canonical completion, then delivers the durable response', async () => {
		const invocation = { id: 'invocation-response', team_id: 'team-1', status: 'running', execution_kind: 'conversation', final_message_ref: 'discussion-messages/topic/response.mdx' };
		let integrated = false;
		const store = {
			all: vi.fn(async (sql: string) => sql.includes('FROM capacity_provider_assignments assignment') ? [] : [invocation]),
			first: vi.fn(async (query: string) => query.includes('capacity_provider_assignments')
				? { id: 'assignment-response', status: 'completed' }
				: query.includes('audit_events') && integrated ? { id: 'integration-receipt' } : null),
			run: vi.fn(), createCapacityWorkdayRun: vi.fn(), tickCapacityWorkdayRun: vi.fn(), updateCapacityWorkdayRun: vi.fn(),
		};
		await expect(reconcileTerminalConversationInvocations(store, 'team-1')).resolves.toEqual({ reconciled: 0 });
		expect(store.run).not.toHaveBeenCalled();
		integrated = true;
		await expect(reconcileTerminalConversationInvocations(store, 'team-1')).resolves.toEqual({ reconciled: 1 });
		expect(store.run).toHaveBeenCalledWith(expect.stringContaining('UPDATE agent_invocation_requests'), expect.arrayContaining(['completed', 'assignment-response']));
		expect(store.run).not.toHaveBeenCalledWith(expect.stringContaining("'agent.failed'"), expect.anything());
	});
	it('fails a stale running invocation and publishes a visible lifecycle event', async () => {
		const invocation = {
			id: 'invocation-old', team_id: 'team-1', project_id: 'project-1', agent_id: 'architect',
			status: 'running', execution_kind: 'conversation', final_message_ref: null,
			metadata_json: { communication: { topicId: 'topic-1', sendId: 'send-1' } },
		};
		const run = vi.fn(async (query: string) => query.includes('UPDATE agent_invocation_requests') ? { changes: 1 } : { changes: 1 });
		const store = {
			all: vi.fn(async (sql: string) => sql.includes('FROM capacity_provider_assignments assignment') ? [] : [invocation]),
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

	it('fails a terminal conversation execution that never received an assignment', async () => {
		const invocation = {
			id: 'invocation-orphan', team_id: 'team-1', project_id: 'project-1', agent_id: 'architect',
			status: 'admitted', execution_id: 'conversation-orphan', execution_kind: 'conversation', final_message_ref: null,
			metadata_json: { communication: { topicId: 'topic-1', sendId: 'send-1' } },
		};
		const run = vi.fn(async () => ({ changes: 1 }));
		const store = {
			all: vi.fn(async (sql: string) => sql.includes('FROM capacity_provider_assignments assignment') ? [] : [invocation]),
			first: vi.fn(async (query: string) => {
				if (query.includes('capacity_provider_assignments')) return null;
				if (query.includes('execution_nodes')) return null;
				if (query.includes('capacity_workday_runs')) return { status: 'degraded' };
				if (query.includes('FROM projects')) return { slug: 'sdk' };
				return null;
			}),
			run,
			createCapacityWorkdayRun: vi.fn(), tickCapacityWorkdayRun: vi.fn(), updateCapacityWorkdayRun: vi.fn(),
		};

		await expect(reconcileTerminalConversationInvocations(store, 'team-1')).resolves.toEqual({ reconciled: 1 });
		expect(run).toHaveBeenCalledWith(expect.stringContaining("status='failed'"), expect.arrayContaining(['invocation-orphan']));
		expect(run).toHaveBeenCalledWith(expect.stringContaining("'agent.failed'"), expect.arrayContaining(['@sdk/architect']));
	});

	it('keeps an admitted invocation active while its graph communication node is ready', async () => {
		const invocation = { id: 'invocation-live', team_id: 'team-1', execution_id: 'conversation-live', execution_kind: 'conversation', status: 'admitted' };
		const store = {
			all: vi.fn(async (sql: string) => sql.includes('FROM capacity_provider_assignments assignment') ? [] : [invocation]),
			first: vi.fn(async (query: string) => query.includes('execution_nodes') ? { id: 'node-live' } : null),
			run: vi.fn(), createCapacityWorkdayRun: vi.fn(), tickCapacityWorkdayRun: vi.fn(), updateCapacityWorkdayRun: vi.fn(),
		};

		await expect(reconcileTerminalConversationInvocations(store, 'team-1')).resolves.toEqual({ reconciled: 0 });
		expect(store.run).not.toHaveBeenCalled();
	});
});
