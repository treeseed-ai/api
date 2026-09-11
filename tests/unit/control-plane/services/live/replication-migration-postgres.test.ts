import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createControlPlanePostgresDatabase } from '../../../../../src/api/support/control-plane-postgres.ts';
import { enqueueTreeDxCommitReplication } from '../../../../../src/api/capacity/services/treedx/repositories/treedx-commit-replication.ts';

const url = process.env.TREESEED_TEST_POSTGRES_URL;
describe.skipIf(!url)('real PostgreSQL replication migration closure', () => {
	it.each(['fresh', 'false-ledger', 'partial-removal'])('repairs %s and inserts without GitHub columns', async state => {
		const connection = new URL(url!);
		if (!['127.0.0.1', 'localhost'].includes(connection.hostname) || connection.pathname !== '/postgres') throw new Error('Use an explicitly provisioned local PostgreSQL test service.');
		const admin = new pg.Pool({ connectionString: connection.href });
		const name = `treeseed_migration_test_${randomUUID().replaceAll('-', '')}`;
		const root = mkdtempSync(join(tmpdir(), 'treeseed-migration-test-'));
		const files = ['0006_treedx_commit_replication.sql', '0017_remove_git_backup_replication.sql', '0018_repair_git_backup_column_removal.sql'];
		for (const file of files) copyFileSync(resolve('drizzle/control-plane', file), join(root, file));
		let created = false;
		let database: ReturnType<typeof createControlPlanePostgresDatabase> | undefined;
		try {
			await admin.query(`CREATE DATABASE "${name}"`); created = true;
			connection.pathname = `/${name}`;
			database = createControlPlanePostgresDatabase(connection.href, { migrationRoot: root, migrationMode: 'apply' });
			await database.pool.query(`CREATE TABLE teams(id text PRIMARY KEY); CREATE TABLE projects(id text PRIMARY KEY);
				CREATE TABLE treedx_project_libraries(project_id text, repository_id text);
				INSERT INTO teams VALUES ('team'); INSERT INTO projects VALUES ('project');
				INSERT INTO treedx_project_libraries VALUES ('project', 'repository');`);
			if (state !== 'fresh') {
				await database.pool.query(readFileSync(join(root, files[0]), 'utf8'));
				await database.pool.query(`CREATE TABLE treeseed_control_plane_schema_migrations(name text PRIMARY KEY, applied_at text NOT NULL);
					INSERT INTO treeseed_control_plane_schema_migrations VALUES ('0006_treedx_commit_replication.sql', 'prior'), ('0017_remove_git_backup_replication.sql', 'prior');`);
				await database.pool.query(`INSERT INTO treedx_commit_replications
					(id,team_id,project_id,repository_id,commit_sha,source_ref,github_ref,r2_object_key,created_at,updated_at)
					VALUES ('existing','team','project','repository',$1,'refs/heads/staging','retired','retained',now(),now())`, ['a'.repeat(40)]);
				if (state === 'partial-removal') await database.pool.query('ALTER TABLE treedx_commit_replications DROP COLUMN github_ref');
			}
			await database.migrate();
			const columns = await database.pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='treedx_commit_replications' AND column_name LIKE 'github_%'");
			expect(columns.rows).toEqual([]);
			const adapter = {
				first: (sql: string, args: unknown[]) => database!.prepare(sql).bind(...args).first(),
				run: (sql: string, args: unknown[]) => database!.prepare(sql).bind(...args).run(),
			};
			const input = { teamId: 'team', projectId: 'project', commitSha: 'b'.repeat(40), sourceRef: 'refs/heads/staging', createdAt: new Date().toISOString() };
			await enqueueTreeDxCommitReplication(adapter as never, input);
			await enqueueTreeDxCommitReplication(adapter as never, input);
			const count = await database.pool.query('SELECT count(*)::int AS count FROM treedx_commit_replications');
			expect(count.rows[0].count).toBe(state === 'fresh' ? 1 : 2);
			await database.close(); database = createControlPlanePostgresDatabase(connection.href, { migrationRoot: root });
			await database.migrate();
			const ledger = await database.pool.query('SELECT name FROM treeseed_control_plane_schema_migrations ORDER BY name');
			expect(ledger.rows.map(row => row.name)).toEqual(files);
		} finally {
			await database?.close();
			if (created) await admin.query(`DROP DATABASE "${name}"`);
			await admin.end();
			rmSync(root, { recursive: true });
		}
	});
});
