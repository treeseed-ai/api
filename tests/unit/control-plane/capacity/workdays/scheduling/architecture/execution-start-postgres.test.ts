import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { expect, it } from 'vitest';
import { createControlPlanePostgresDatabase } from '../../../../../../../src/api/support/control-plane-postgres.ts';
import { canonicalJson } from '../../../../../../../src/api/capacity/security.ts';
import { executionWorkdayStart, verifyRetainedWorkdayStart } from '../../../../../../acceptance/execution-inventory.ts';
import { executionStartFixture } from './execution-start-fixture.ts';

// Controlled original receipt input in fully migrated native PostgreSQL. This
// exercises real independent SQL connections and the managed consumer; it does
// not claim provider dispatch, actual governed proposals or producer completeness.
it('native PostgreSQL independently binds retained start and public run across concurrent reads denial interruption and exact retry without mutation', async () => {
	const url = process.env.TREESEED_TEST_POSTGRES_URL;
	if (!url) throw new Error('TREESEED_TEST_POSTGRES_URL required; native receipt custody cannot be skipped.');
	const connection = new URL(url);
	if (connection.hostname !== '127.0.0.1' || connection.pathname !== '/postgres') throw new Error('Explicit disposable loopback PostgreSQL required.');
	const admin = new pg.Pool({ connectionString: connection.href });
	const name = `treeseed_start_test_${randomUUID().replaceAll('-', '')}`, f = executionStartFixture();
	let database: ReturnType<typeof createControlPlanePostgresDatabase> | undefined, peer: pg.Pool | undefined, created = false;
	try {
		await admin.query(`CREATE DATABASE "${name}"`); created = true; connection.pathname = `/${name}`;
		database = createControlPlanePostgresDatabase(connection.href, { migrationMode: 'apply' }); await database.migrate();
		peer = new pg.Pool({ connectionString: connection.href, max: 1 });
		const owner = database.pool, observer = peer;
		const pids = await Promise.all([owner, observer].map(pool => pool.query('SELECT pg_backend_pid() AS pid')));
		expect(pids[0]!.rows[0].pid).not.toBe(pids[1]!.rows[0].pid);
		const now = f.receipt.startedAt;
		await owner.query('INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ($1,$1,$1,$2,$2)', ['team', now]);
		await owner.query(`INSERT INTO capacity_operation_receipts
			(id,team_id,operation,idempotency_key,request_digest,resource_type,resource_id,response_json,created_at,updated_at)
			VALUES ($1,$2,'workday.start',$3,$4,'workday_start',$5,$6,$7,$7)`,
			['original', 'team', `golden-start:${f.freeze.preflight.id}`, `sha256:${f.receipt.transactionReceiptId.slice('workday-start:'.length)}`,
				f.receipt.workdayId, canonicalJson(f.receipt), now]);
		const query = async (sql: string, parameters: unknown[]) => (await observer.query(sql, parameters)).rows;
		const original = (await owner.query('SELECT * FROM capacity_operation_receipts ORDER BY id')).rows;
		const bytes = readFileSync(`${f.path}.workday-start.json`);
		const held = executionWorkdayStart(f.environment);
		await Promise.all(Array.from({ length: 4 }, () => verifyRetainedWorkdayStart(held, f.run, query)));
		for (const changed of [{ team_id: 'foreign' }, { resource_id: 'foreign' }, { operation: 'other' }, { resource_type: 'other' },
			{ idempotency_key: 'foreign' }, { request_digest: '0'.repeat(64) }, { response_json: '{}' }]) {
			const [key, value] = Object.entries(changed)[0]!;
			// Keys above are fixed test-owned column identifiers, never caller input.
			if (key === 'team_id') await owner.query('INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ($1,$1,$1,$2,$2) ON CONFLICT DO NOTHING', ['foreign', now]);
			await owner.query(`UPDATE capacity_operation_receipts SET ${key}=$1 WHERE id='original'`, [value]);
			const failed = (await owner.query('SELECT * FROM capacity_operation_receipts ORDER BY id')).rows;
			await expect(verifyRetainedWorkdayStart(held, f.run, query)).rejects.toThrow();
			expect((await observer.query('SELECT * FROM capacity_operation_receipts ORDER BY id')).rows).toEqual(failed);
			await owner.query(`UPDATE capacity_operation_receipts SET ${key}=$1 WHERE id='original'`, [original[0][key]]);
			await verifyRetainedWorkdayStart(held, f.run, query);
		}
		const interrupted = await observer.connect();
		try {
			const pid = (await interrupted.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
			const pending = verifyRetainedWorkdayStart(held, f.run, async () => {
				return (await interrupted.query('SELECT pg_sleep(10)')).rows;
			});
			const rejected = expect(pending).rejects.toMatchObject({ code: '57014' });
			const deadline = Date.now() + 5_000; let active = false;
			while (Date.now() < deadline) {
				const activity = await owner.query("SELECT state,wait_event FROM pg_stat_activity WHERE pid=$1", [pid]);
				if (activity.rows[0]?.state === 'active' && activity.rows[0]?.wait_event === 'PgSleep') { active = true; break; }
				await new Promise(resolve => setTimeout(resolve, 10));
			}
			expect(active, 'Actual in-flight native command required before interruption').toBe(true);
			expect((await owner.query('SELECT pg_cancel_backend($1) AS cancelled', [pid])).rows).toEqual([{ cancelled: true }]);
			await rejected;
		} finally { interrupted.release(); }
		await verifyRetainedWorkdayStart(held, f.run, query);
		await expect(verifyRetainedWorkdayStart(held, f.run, async (sql, parameters) => {
			const rows = await query(sql, parameters); writeFileSync(`${f.path}.workday-start.json`, '{}'); return rows;
		})).rejects.toThrow();
		writeFileSync(`${f.path}.workday-start.json`, bytes); await verifyRetainedWorkdayStart(held, f.run, query);
		expect((await owner.query('SELECT * FROM capacity_operation_receipts ORDER BY id')).rows).toEqual(original);
		expect(readFileSync(`${f.path}.workday-start.json`)).toEqual(bytes);
	} finally {
		try { await peer?.end(); } finally {
			try { await database?.close(); } finally {
				try { if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); } finally { await admin.end(); f.close(); }
			}
		}
	}
}, 30_000);
