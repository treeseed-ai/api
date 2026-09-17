import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createControlPlanePostgresDatabase } from '../../../../../src/api/support/control-plane-postgres.ts';
import { admitDiscussionInvocations } from '../../../../../src/api/capacity/services/capacity/invocations/discussion-invocation-service.ts';

describe.skipIf(!process.env.TREESEED_TEST_POSTGRES_URL)('current communication supply in PostgreSQL', () => {
	it('uses reported capability lanes rather than the retired materialized lane owner', async () => {
		const connection = new URL(process.env.TREESEED_TEST_POSTGRES_URL!);
		if (connection.hostname !== '127.0.0.1' || connection.pathname !== '/postgres') throw new Error('Disposable loopback PostgreSQL required.');
		const admin = new pg.Pool({ connectionString: connection.href });
		const name = `treeseed_discussion_test_${randomUUID().replaceAll('-', '')}`;
		await admin.query(`CREATE DATABASE "${name}"`);
		connection.pathname = `/${name}`;
		const database = createControlPlanePostgresDatabase(connection.href, { migrationMode: 'apply' });
		try {
			await database.migrate();
			const now = new Date().toISOString();
			await database.pool.query(`INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ('team','team','Team',$1,$1)`, [now]);
			await database.pool.query(`INSERT INTO capacity_providers (id,fingerprint,public_jwk_json,display_name,created_at,updated_at) VALUES ('provider','test','{}','Provider',$1,$1)`, [now]);
			await database.pool.query(`INSERT INTO capacity_provider_team_memberships (id,team_id,capacity_provider_id,status,approved_at,approved_by_id,created_at,updated_at) VALUES ('membership','team','provider','approved',$1,'test',$1,$1)`, [now]);
			for (const id of ['codex-managed', 'codex-implementation', 'codex-research']) {
				await database.pool.query(`INSERT INTO capacity_execution_providers (id,capacity_provider_id,display_name,adapter,native_unit,max_concurrent_runners,status,created_at,updated_at) VALUES ($1,'provider',$1,'codex','seconds',1,$2,$3,$3)`, [id, id === 'codex-managed' ? 'revoked' : 'active', now]);
			}
			await database.pool.query(`INSERT INTO capacity_provider_lanes (id,capacity_provider_id,execution_provider_id,display_name,purpose,max_concurrent_runners,created_at,updated_at) VALUES ('communication','provider','codex-managed','Communication','communication',1,$1,$1)`, [now]);
			const report = [
				{ id: 'codex-implementation', status: 'active', lanes: [{ purpose: 'communication', maxConcurrentWorkers: 1 }] },
				{ id: 'codex-research', status: 'active', lanes: [{ purpose: 'workday', maxConcurrentWorkers: 1 }] },
			];
			await database.pool.query(`INSERT INTO capacity_provider_availability_sessions (id,membership_id,team_id,capacity_provider_id,status,opened_at,refreshed_at,expires_at,available_from,execution_providers_json,created_at,updated_at) VALUES ('session','membership','team','provider','open',$1,$1,$2,$1,$3,$1,$1)`, [now, new Date(Date.now() + 60_000).toISOString(), JSON.stringify(report)]);
			const agent = { schemaVersion: 'treeseed.agent/v1', id: 'sdk/architect', name: 'Architect', agentClass: 'architect', purpose: 'Inspect architecture.', responsibilities: ['Inspect architecture.'], capabilities: ['repository-analysis'], context: { include: ['project-objectives'] }, activityProfiles: { chat: { handler: 'writer', permissions: { content: { read: ['knowledge', 'discussion'], write: ['discussion'] }, tools: ['discussion', 'source.read'] }, prompt: { system: 'Answer using evidence.' } } } };
			let claim: Record<string, unknown> | null = null;
			const store = {
				all: async (sql: string, values: unknown[] = []) => sql.includes('project_agent_classes') ? [{ id: 'class', handler_refs_json: { agents: [agent] }, metadata_json: { immutableRef: 'a'.repeat(40) } }] : (await database.prepare(sql).bind(...values).all()).results,
				first: async (sql: string, values: unknown[] = []) => sql.includes('SELECT status,execution_id,blocking_state_json FROM agent_invocation_requests') ? claim : sql.includes('agent_invocation_requests') ? null : database.prepare(sql).bind(...values).first(),
				run: async (sql: string, values: unknown[] = []) => {
					if (sql.includes("SET status='admitted',execution_id=?")) claim = { status: 'admitted', execution_id: values[0], blocking_state_json: values[1] };
					return { meta: { changes: 1 } };
				},
				createCapacityWorkdayRun: vi.fn(async (_team: string, input: Record<string, unknown>) => ({ id: input.id })),
				tickCapacityWorkdayRun: vi.fn(async () => ({})), updateCapacityWorkdayRun: vi.fn(async () => null),
			};
			const input = { teamId: 'team', projectId: 'project', projectSlug: 'sdk', discussionId: 'acceptance', messageId: 'message', messagePath: 'discussion-messages/acceptance/message.mdx', messageCommit: 'c'.repeat(40), contextRefs: [], agentSlugs: ['architect'], idempotencyKey: 'send', durationSeconds: 180 };
			expect(await admitDiscussionInvocations(store, input)).toMatchObject([{ status: 'admitted' }]);
			expect(store.createCapacityWorkdayRun).toHaveBeenCalledOnce();
			// The same materialized rows must not authorize an expired report.
			await database.pool.query(`UPDATE capacity_provider_availability_sessions SET expires_at=$1`, [now]);
			expect(await admitDiscussionInvocations(store, { ...input, idempotencyKey: 'expired' })).toMatchObject([{ status: 'blocked', blocker: 'communication_supply_unavailable' }]);
			expect(store.createCapacityWorkdayRun).toHaveBeenCalledOnce();
		} finally {
			await database.pool.end();
			await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
			await admin.end();
		}
	}, 30_000);
});
