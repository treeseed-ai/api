import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createControlPlanePostgresDatabase, type ControlPlanePostgresDatabase } from '../../../../src/api/support/control-plane-postgres.ts';

const url = process.env.TREESEED_TEST_POSTGRES_URL;
describe.skipIf(!url)('API shared-server runtime boundary', () => {
  it('migrates separately and validates the entire schema without runtime DDL authority', async () => {
    const connection = new URL(url!);
    if (!['127.0.0.1', 'localhost'].includes(connection.hostname) || connection.pathname !== '/postgres') throw new Error('Disposable local PostgreSQL required');
    const admin = new pg.Pool({ connectionString: connection.href });
    const name = `api_role_${randomBytes(8).toString('hex')}`;
    const owner = `${name}_owner`, migrator = `${name}_migrator`, runtime = `${name}_runtime`;
    const migrationPassword = randomBytes(32).toString('hex'), runtimePassword = randomBytes(32).toString('hex');
    let migration: ControlPlanePostgresDatabase | undefined, application: ControlPlanePostgresDatabase | undefined;
    let databaseCreated = false;
    const roles: string[] = [];
    try {
      // Disposable test fixture only; production allocation belongs to Deployment.
      await admin.query(`CREATE ROLE ${owner} NOLOGIN`); roles.push(owner);
      await admin.query(`CREATE ROLE ${migrator} LOGIN PASSWORD '${migrationPassword}' IN ROLE ${owner}`); roles.push(migrator);
      await admin.query(`CREATE ROLE ${runtime} LOGIN PASSWORD '${runtimePassword}'`); roles.push(runtime);
      await admin.query(`ALTER ROLE ${migrator} SET role='${owner}'`);
      await admin.query(`CREATE DATABASE ${name} OWNER ${owner}`); databaseCreated = true;
      await admin.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC; GRANT CONNECT ON DATABASE ${name} TO ${migrator},${runtime}`);
      connection.pathname = `/${name}`; connection.username = migrator; connection.password = migrationPassword;
      migration = createControlPlanePostgresDatabase(connection.href, { migrationMode: 'apply' });
      await migration.migrate();
      await migration.pool.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC;
        GRANT USAGE ON SCHEMA public TO ${runtime};
        GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${runtime};
        GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${runtime}`);
      await migration.close(); migration = undefined;
      await admin.query(`ALTER ROLE ${migrator} NOLOGIN`);
      connection.username = runtime; connection.password = runtimePassword;
      application = createControlPlanePostgresDatabase(connection.href);
      await application.migrate();
      const identity = await application.pool.query('SELECT current_user AS role');
      expect(identity.rows[0].role).toBe(runtime);
      await application.prepare("INSERT INTO users(id,status,created_at,updated_at) VALUES (?,?,?,?)").bind('retained-user', 'active', 'now', 'now').run();
      expect((await application.prepare('SELECT id FROM users WHERE id=?').bind('retained-user').all()).results[0]?.id).toBe('retained-user');
      await expect(application.pool.query('CREATE TABLE forbidden(id integer)')).rejects.toMatchObject({ code: '42501' });
      await expect(application.pool.query(`SET ROLE ${owner}`)).rejects.toMatchObject({ code: '42501' });
      await expect(application.pool.query(`SET ROLE ${migrator}`)).rejects.toMatchObject({ code: '42501' });
      await application.migrate();
    } finally {
      await application?.close(); await migration?.close();
      if (databaseCreated) await admin.query(`DROP DATABASE ${name}`);
      for (const role of roles.reverse()) await admin.query(`DROP ROLE ${role}`);
      await admin.end();
    }
  }, 60000);
});
