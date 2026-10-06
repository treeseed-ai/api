import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { executePostgresBatch, translateControlPlaneSqlToPostgres } from '../../../../../src/api/support/control-plane-postgres.ts';
import { recordAssignmentDiscussionResponse } from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-discussion-response-service.ts';
import { reconcileTerminalConversationInvocations } from '../../../../../src/api/capacity/services/capacity/invocations/discussion-invocation-service.ts';

vi.mock('../../../../../src/api/knowledge/gateway-treedx-connection.ts', () => ({
	resolveKnowledgeGatewayConnection: async () => ({ repositoryId: 'repo', client: {
		readRepositoryFiles: async (input: { ref: string; paths: string[] }) => ({ resolvedRef: input.ref,
			files: input.paths.map((path) => ({ path, content: 'Exact committed response' })) }),
	} }),
}));

describe('discussion publication SQL authority', () => {
	it('real PostgreSQL terminal reconciliation preserves exact failed actor attribution and one unchanged event across replay', async () => {
		const binding = process.env.TREESEED_TEST_POSTGRES_URL;
		if (!binding) throw new Error('TREESEED_TEST_POSTGRES_URL is required; native failure attribution cannot be skipped.');
		const url = new URL(binding);
		if (url.hostname !== '127.0.0.1' || url.pathname !== '/postgres') throw new Error('Disposable loopback PostgreSQL required.');
		const pool = new pg.Pool({ connectionString: url.href }), client = await pool.connect();
		try {
			await client.query('BEGIN');
			await client.query(`CREATE TEMP TABLE capacity_provider_assignments (id text,team_id text,project_id text,assignment_result_json jsonb,status text,invocation_id text,updated_at text,lifecycle_code text,lifecycle_reason text);
				CREATE TEMP TABLE agent_invocation_requests (id text,team_id text,project_id text,agent_id text,assignment_id text,status text,final_message_ref text,updated_at text,execution_kind text,requested_at text,completed_at text,blocking_state_json jsonb,metadata_json jsonb);
				CREATE TEMP TABLE audit_events (id text,target_type text,target_id text,event_type text);
				CREATE TEMP TABLE projects (id text,slug text);
				CREATE TEMP TABLE communication_topic_events (id text PRIMARY KEY,topic_id text,team_id text,event_type text,occurred_at text,send_id text,invocation_id text,assignment_id text,actor_kind text,actor_id text,actor_handle text,summary text,payload_json jsonb);`);
			const store = { first: async (sql: string, values: unknown[] = []) => (await client.query(translateControlPlaneSqlToPostgres(sql), values)).rows[0] ?? null,
				all: async (sql: string, values: unknown[] = []) => (await client.query(translateControlPlaneSqlToPostgres(sql), values)).rows,
				run: async (sql: string, values: unknown[] = []) => client.query(translateControlPlaneSqlToPostgres(sql), values),
				createCapacityWorkdayRun: async () => { throw new Error('Failure reconciliation must not create a run'); },
				tickCapacityWorkdayRun: async () => { throw new Error('Failure reconciliation must not tick a run'); },
				updateCapacityWorkdayRun: async () => { throw new Error('Failure reconciliation must not change a run'); } };
			for (const [id, agent, slug, expected] of [['missing-project', 'renamed-agent', null, '@missing-project/renamed-agent'],
				['blank-agent', ' ', 'sdk', '@sdk/agent'], ['named', 'renamed-agent', 'sdk', '@sdk/renamed-agent']] as const) {
				if (slug) await client.query('INSERT INTO projects VALUES ($1,$2)', [id, slug]);
				await client.query("INSERT INTO capacity_provider_assignments (id,team_id,status,invocation_id,lifecycle_code) VALUES ($1,'team','failed',$2,'original_failure')", [`assignment-${id}`, `invocation-${id}`]);
				await client.query("INSERT INTO agent_invocation_requests (id,team_id,project_id,agent_id,status,execution_kind,metadata_json) VALUES ($1,'team',$2,$3,'running','conversation',$4)",
					[`invocation-${id}`, id, agent, JSON.stringify({ communication: { topicId: 'topic', sendId: 'send' } })]);
				const assignments = (await client.query('SELECT * FROM capacity_provider_assignments ORDER BY id')).rows;
				expect(await reconcileTerminalConversationInvocations(store, 'team')).toEqual({ reconciled: 1 });
				const events = (await client.query('SELECT * FROM communication_topic_events ORDER BY id')).rows;
				expect(events.filter(row => row.invocation_id === `invocation-${id}`)).toMatchObject([{ actor_handle: expected, actor_id: agent,
					actor_kind: 'agent', event_type: 'agent.failed', payload_json: { code: 'terminal_assignment_without_final_response', assignmentStatus: 'failed', lifecycleCode: 'original_failure' } }]);
				const invocations = (await client.query('SELECT * FROM agent_invocation_requests ORDER BY id')).rows;
				expect(invocations.find(row => row.id === `invocation-${id}`)?.status).toBe('failed');
				expect(await reconcileTerminalConversationInvocations(store, 'team')).toEqual({ reconciled: 0 });
				expect((await client.query('SELECT * FROM communication_topic_events ORDER BY id')).rows).toEqual(events);
				expect((await client.query('SELECT * FROM agent_invocation_requests ORDER BY id')).rows).toEqual(invocations);
				expect((await client.query('SELECT * FROM capacity_provider_assignments ORDER BY id')).rows).toEqual(assignments);
			}
		} finally { await client.query('ROLLBACK'); client.release(); await pool.end(); }
	});
	it('retains the exact live lease and blocks stale or cross-team response attribution in PostgreSQL', async () => {
		const binding = process.env.TREESEED_TEST_POSTGRES_URL;
		if (!binding) throw new Error('TREESEED_TEST_POSTGRES_URL is required; native discussion publication cannot be skipped.');
		const url = new URL(binding);
		if (url.hostname !== '127.0.0.1' || url.pathname !== '/postgres') throw new Error('Disposable loopback PostgreSQL required.');
		const pool = new pg.Pool({ connectionString: url.href });
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			await client.query(`CREATE TEMP TABLE capacity_provider_assignments (id text,team_id text,project_id text,assignment_result_json jsonb,status text,lease_state text,lease_token text,invocation_id text,updated_at text,lifecycle_code text,lifecycle_reason text);
				CREATE TEMP TABLE agent_invocation_requests (id text,team_id text,assignment_id text,status text,final_message_ref text,response_json jsonb,updated_at text,execution_kind text,requested_at text,completed_at text,blocking_state_json jsonb);
				CREATE TEMP TABLE audit_events (id text PRIMARY KEY,actor_type text,actor_id text,target_type text,target_id text,event_type text,data_json jsonb,created_at text);
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
			// The process may crash after completion but before its content receipt.
			// Retry must produce the receipt from the real canonical result, not test-authored audit rows.
			const result = { schemaVersion: 'treeseed.assignment-result/v1', id: 'result', assignmentId: 'assignment',
				status: 'completed', summary: 'Done', references: [input.reference], verification: [],
				usage: { elapsedSeconds: 1 }, diagnostics: [], completedAt: '2026-09-26T19:08:00.000Z' };
			await client.query("UPDATE capacity_provider_assignments SET project_id='project',assignment_result_json=$1", [JSON.stringify(result)]);
			await expect(reconcileTerminalConversationInvocations(store as never, 'team')).resolves.toEqual({ reconciled: 1 });
			expect((await client.query('SELECT event_type,data_json FROM audit_events')).rows).toEqual([
				{ event_type: 'assignment.content.integrated', data_json: { resultId: 'result', references: [input.reference], publication: false } }]);
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
