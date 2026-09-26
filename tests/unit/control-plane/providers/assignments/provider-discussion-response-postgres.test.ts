import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { executePostgresBatch, translateControlPlaneSqlToPostgres } from '../../../../../src/api/support/control-plane-postgres.ts';
import { recordAssignmentDiscussionResponse } from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-discussion-response-service.ts';
import { reconcileTerminalConversationInvocations } from '../../../../../src/api/capacity/services/capacity/invocations/discussion-invocation-service.ts';

describe.skipIf(!process.env.TREESEED_TEST_POSTGRES_URL)('discussion publication SQL authority', () => {
	it('retains the exact live lease and blocks stale or cross-team response attribution in PostgreSQL', async () => {
		const url = new URL(process.env.TREESEED_TEST_POSTGRES_URL!);
		if (url.hostname !== '127.0.0.1' || url.pathname !== '/postgres') throw new Error('Disposable loopback PostgreSQL required.');
		const pool = new pg.Pool({ connectionString: url.href });
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			await client.query(`CREATE TEMP TABLE capacity_provider_assignments (id text,team_id text,status text,lease_state text,lease_token text,invocation_id text,updated_at text,lifecycle_code text,lifecycle_reason text);
				CREATE TEMP TABLE agent_invocation_requests (id text,team_id text,assignment_id text,status text,final_message_ref text,response_json jsonb,updated_at text,execution_kind text,requested_at text,completed_at text,blocking_state_json jsonb);
				CREATE TEMP TABLE audit_events (id text,target_type text,target_id text,event_type text);
				INSERT INTO capacity_provider_assignments (id,team_id,status,lease_state,lease_token,invocation_id) VALUES ('assignment','team','leased','leased','lease','invocation');
				INSERT INTO agent_invocation_requests (id,team_id,assignment_id,status,execution_kind) VALUES ('invocation','team','assignment','running','conversation');`);
			const store = {
				batch: (operations: Array<{ query: string; params?: unknown[] }>) => executePostgresBatch(client, operations),
				first: async (sql: string, values: unknown[]) => (await client.query(translateControlPlaneSqlToPostgres(sql), values)).rows[0] ?? null,
				all: async (sql: string, values: unknown[]) => (await client.query(translateControlPlaneSqlToPostgres(sql), values)).rows,
				run: async (sql: string, values: unknown[]) => client.query(translateControlPlaneSqlToPostgres(sql), values),
			};
			const input = { assignmentId: 'assignment', invocationId: 'invocation', teamId: 'team', leaseToken: 'lease',
				messagePath: 'discussion-messages/response.mdx', outcome: 'responded' as const,
				reference: { kind: 'treedx' as const, projectId: 'project', repository: 'repo', commit: 'a'.repeat(40), path: 'discussion-messages/response.mdx', workspaceId: 'workspace' } };
			for (const invalid of [{ ...input, teamId: 'other-team' }, { ...input, leaseToken: 'stale' }])
				await expect(recordAssignmentDiscussionResponse(store as never, invalid)).rejects.toMatchObject({ code: 'communication_response_record_failed' });
			await recordAssignmentDiscussionResponse(store as never, input);
			await recordAssignmentDiscussionResponse(store as never, input);
			const assignment = (await client.query('SELECT * FROM capacity_provider_assignments')).rows[0];
			expect(assignment).toMatchObject({ status: 'leased', lease_state: 'leased', lease_token: 'lease' });
			const invocation = (await client.query('SELECT * FROM agent_invocation_requests')).rows[0];
			expect(invocation).toMatchObject({ status: 'running', final_message_ref: input.messagePath, response_json: { outcome: 'responded', reference: input.reference } });
			await client.query("UPDATE capacity_provider_assignments SET status='completed',lease_state='released',lease_token=NULL");
			await expect(reconcileTerminalConversationInvocations(store as never, 'team')).resolves.toEqual({ reconciled: 0 });
			expect((await client.query('SELECT status FROM agent_invocation_requests')).rows[0].status).toBe('running');
			await client.query("INSERT INTO audit_events VALUES ('integrated','capacity_provider_assignment','assignment','assignment.content.integrated')");
			await expect(reconcileTerminalConversationInvocations(store as never, 'team')).resolves.toEqual({ reconciled: 1 });
			expect((await client.query('SELECT status FROM agent_invocation_requests')).rows[0].status).toBe('completed');
			await expect(reconcileTerminalConversationInvocations(store as never, 'team')).resolves.toEqual({ reconciled: 0 });
			await expect(recordAssignmentDiscussionResponse(store as never, input)).rejects.toMatchObject({ code: 'communication_response_record_failed' });
		} finally {
			await client.query('ROLLBACK');
			client.release();
			await pool.end();
		}
	});
});
