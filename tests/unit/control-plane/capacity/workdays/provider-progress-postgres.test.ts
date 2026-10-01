import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createControlPlanePostgresDatabase } from '../../../../../src/api/support/control-plane-postgres.ts';
import { CapacityWorkdayEventService } from '../../../../../src/api/capacity/services/capacity/workdays/content/workday-event-service.ts';
import { appendDiscussionEvent } from '../../../../../src/api/discussions/content.ts';

vi.mock('../../../../../src/api/discussions/content.ts', () => ({ appendDiscussionEvent: vi.fn(async () => { throw new Error('No progress TreeDX commit allowed'); }) }));
vi.mock('../../../../../src/api/realtime/session-events.ts', () => ({ persistSessionEvent: vi.fn(async () => undefined) }));

describe.skipIf(!process.env.TREESEED_TEST_POSTGRES_URL)('provider progress durable PostgreSQL custody', () => {
	it('retains captured preparation evidence and ordered replay without duplicate discussion commits', async () => {
		const connection = new URL(process.env.TREESEED_TEST_POSTGRES_URL!);
		if (connection.hostname !== '127.0.0.1' || connection.pathname !== '/postgres') throw new Error('Disposable loopback PostgreSQL required.');
		const admin = new pg.Pool({ connectionString: connection.href });
		const name = `treeseed_progress_test_${randomUUID().replaceAll('-', '')}`;
		await admin.query(`CREATE DATABASE "${name}"`); connection.pathname = `/${name}`;
		const database = createControlPlanePostgresDatabase(connection.href, { migrationMode: 'apply' });
		try {
			await database.migrate(); const now = '2026-10-01T21:31:38.491Z';
			await database.pool.query(`INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ('team','team','Team',$1,$1)`, [now]);
			await database.pool.query(`INSERT INTO projects (id,team_id,slug,name,created_at,updated_at) VALUES ('sdk','team','sdk','SDK',$1,$1)`, [now]);
			await database.pool.query(`INSERT INTO capacity_workday_runs (id,team_id,status,execution_mode,scenario_id,environment,execution_kind,trigger_kind,parameters_json,created_at,updated_at)
				VALUES ('run','team','running','simulation','profile:default','local','workday','manual',$1,$2,$2)`, [JSON.stringify({ discussion: { discussionId: 'topic' } }), now]);
			const service = new CapacityWorkdayEventService({
				ensureInitialized: () => database.migrate(),
				run: async (sql: string, params: unknown[] = []) => { await database.prepare(sql).bind(...params).run(); },
				first: (sql: string, params: unknown[] = []) => database.prepare(sql).bind(...params).first(),
				all: async (sql: string, params: unknown[] = []) => (await database.prepare(sql).bind(...params).all()).results,
				batch: (operations: Array<{ query: string; params?: unknown[] }>) => database.batch(operations),
			});
			const values = ['provider.execution.preparing', 'provider.sandbox.created', 'provider.execution.progress', 'provider.execution.progress']
				.map((eventType, index) => ({ id: `provider-runtime:assignment:trace:${index}`, eventType, status: 'recorded',
					projectId: 'sdk', workdayId: 'run', assignmentId: 'assignment', createdAt: now,
					context: { component: 'execution-provider', stage: index === 3 ? 'source.ready' : 'source.preparing' },
					refs: { source: 'exact-source-ref' }, metadata: { redactionStatus: 'sanitized' } }));
			for (const value of values) { await service.create('team', 'run', value); await service.create('team', 'run', value); }
			const replay = await service.list('team', 'run');
			expect(replay.items).toHaveLength(4);
			expect(replay.items.map(event => event.eventIndex)).toEqual([0, 1, 2, 3]);
			for (const value of values) expect(replay.items.find(event => event.id === value.id)).toMatchObject(value);
			expect(appendDiscussionEvent).not.toHaveBeenCalled();
			await expect(service.create('team', 'run', { ...values[0], context: { stage: 'forged' } })).rejects.toMatchObject({ code: 'capacity_workday_event_idempotency_conflict' });
			expect((await database.pool.query('SELECT next_event_index FROM capacity_workday_runs WHERE id=$1', ['run'])).rows[0].next_event_index).toBe(4);
		} finally {
			await database.pool.end(); await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); await admin.end();
		}
	}, 30_000);
});
