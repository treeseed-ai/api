import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createControlPlanePostgresDatabase } from '../../../../../../src/api/support/control-plane-postgres.ts';
import { CapacityWorkdayRunService } from '../../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-run-service.ts';
import { loadCommunicationInvocations } from '../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';
import { projectCommunicationInvocations } from '../../../../../../src/api/capacity/policy/execution/communication-execution-projector.ts';

describe.skipIf(!process.env.TREESEED_TEST_POSTGRES_URL)('concurrent local execution in PostgreSQL', () => {
	it('preserves production and simulation workdays when another workday or conversation starts', async () => {
		const connection = new URL(process.env.TREESEED_TEST_POSTGRES_URL!);
		if (connection.hostname !== '127.0.0.1' || connection.pathname !== '/postgres') throw new Error('Disposable loopback PostgreSQL required.');
		const admin = new pg.Pool({ connectionString: connection.href });
		const name = `treeseed_runs_test_${randomUUID().replaceAll('-', '')}`;
		await admin.query(`CREATE DATABASE "${name}"`);
		connection.pathname = `/${name}`;
		const database = createControlPlanePostgresDatabase(connection.href, { migrationMode: 'apply' });
		try {
			await database.migrate();
			const now = new Date().toISOString();
			await database.pool.query(`INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ('team','team','Team',$1,$1)`, [now]);
			await database.pool.query(`INSERT INTO capacity_providers (id,fingerprint,public_jwk_json,display_name,created_at,updated_at) VALUES ('provider','test','{}','Provider',$1,$1)`, [now]);
			const store = {
				ensureInitialized: () => database.migrate(),
				run: (sql: string, values: unknown[]) => database.prepare(sql).bind(...values).run(),
				first: (sql: string, values: unknown[]) => database.prepare(sql).bind(...values).first(),
				all: async (sql: string, values: unknown[]) => (await database.prepare(sql).bind(...values).all()).results,
				batch: (operations: Array<{ query: string; params?: unknown[] }>) => database.batch(operations),
				scheduleCapacityWorkdayRun: vi.fn(async () => ({})),
				closeCapacityWorkdayAdmission: vi.fn(), terminalizeCapacityWorkdayAssignments: vi.fn(), terminalizeCapacityWorkdayEnvelopes: vi.fn(),
			};
			const service = new CapacityWorkdayRunService(store as never);
			for (const [id, executionMode, executionKind] of [
				['production', 'production', 'workday'], ['sdk', 'simulation', 'workday'],
				['api', 'simulation', 'workday'], ['chat', 'production', 'conversation'],
			]) await service.create('team', { id, executionMode, executionKind, capacityProviderId: 'provider', environment: 'local', status: 'running', startedAt: now, parameters: { durationSeconds: 600, allocationWeight: 1, planningPercent: 20 } });
			expect((await database.pool.query('SELECT id,status,error_json FROM capacity_workday_runs ORDER BY id')).rows)
				.toEqual(['api', 'chat', 'production', 'sdk'].map(id => ({ id, status: 'running', error_json: '{}' })));
			expect(store.scheduleCapacityWorkdayRun).toHaveBeenCalledTimes(4);
			expect(store.closeCapacityWorkdayAdmission).not.toHaveBeenCalled();
			expect(store.terminalizeCapacityWorkdayAssignments).not.toHaveBeenCalled();
			expect(store.terminalizeCapacityWorkdayEnvelopes).not.toHaveBeenCalled();
			await database.pool.query(`INSERT INTO projects (id,team_id,slug,name,created_at,updated_at) VALUES ('project','team','sdk','SDK',$1,$1)`, [now]);
			await database.pool.query(`INSERT INTO treedx_project_libraries (id,team_id,project_id,instance_id,library_id,repository_id,content_path,created_at,updated_at)
				VALUES ('library','team','project','instance','library','repo','.', $1,$1)`, [now]);
			const roles = ['architect','researcher','tester','engineer','technical-writer','releaser','reviewer','reporter'];
			for (const [id, run, kind, agent] of [...roles.map(role => [`sdk-${role}`, 'sdk', 'conversation', role]),
				['chat-architect','chat','conversation','architect'], ['stopped-architect','api','conversation','architect']]) {
				await database.pool.query(`INSERT INTO agent_invocation_requests
					(id,team_id,project_id,agent_id,execution_kind,status,scope_hash,available_at,idempotency_key,request_digest,execution_id,metadata_json,requested_at,updated_at)
					VALUES ($1,'team','project',$2,$3,'admitted','scope',$4,$1,'digest',$5,$6,$4,$4)`,
				[id, agent, kind, now, run, JSON.stringify({ sourceMessagePath: `discussion-messages/${id}.mdx`, sourceCommit: 'a'.repeat(40), productiveSeconds: 180 })]);
			}
			await database.pool.query(`UPDATE capacity_workday_runs SET status='cancelled' WHERE id='api'`);
			const sources = await loadCommunicationInvocations(store, 'team');
			expect(sources).toHaveLength(9);
			expect(sources.filter(source => source.workdayId === 'sdk').map(source => source.agentId).sort()).toEqual([...roles].sort());
			expect(sources.some(source => source.workdayId === 'api')).toBe(false);
			const profiles = Object.fromEntries(roles.map(role => [`project:${role}`, {
				schemaVersion: 'treeseed.agent/v1' as const, id: `sdk/${role}`, name: role, agentClass: role,
				purpose: 'Answer bounded questions.', responsibilities: ['Answer questions.'], capabilities: ['reasoning'], context: { include: ['project-objectives'] },
				activityProfiles: { chat: { handler: 'writer', permissions: { content: { read: ['discussion'], write: ['discussion'] }, tools: ['discussion'] }, prompt: { system: 'Answer with evidence.' } } },
			}]));
			const projected = projectCommunicationInvocations({ teamId: 'team', revision: 1, sources, profiles });
			expect(projected.nodes.filter(node => node.workdayId === 'sdk')).toHaveLength(8);
			expect(projected.nodes.map(node => node.sourceRef.id)).toEqual(sources.map(source => source.id).sort());
		} finally {
			await database.pool.end();
			await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
			await admin.end();
		}
	}, 30_000);
});
