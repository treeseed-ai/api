import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { AUTH_SCHEMA_SQL } from '../../../../../src/api/auth/postgres-store.ts';
import { splitPostgresSqlStatements } from '../../../../../src/api/persistence/postgres-sql-statements.ts';
import { createIdentityPrincipalStore } from '../../../../../src/api/auth/identity/principal-store.ts';

const url = process.env.TREESEED_TEST_POSTGRES_URL;
describe.skipIf(!url)('read-only Identity authorization in real PostgreSQL', () => {
  it('preserves local roles, observes revocation, and cannot write or create retired issuer tables', async () => {
    const connection = new URL(url!);
    if (!['127.0.0.1', 'localhost'].includes(connection.hostname) || connection.pathname !== '/postgres') throw new Error('Disposable local PostgreSQL required');
    const admin = new pg.Pool({ connectionString: connection.href });
    const name = `treeseed_identity_test_${randomUUID().replaceAll('-', '')}`;
    let created = false, pool: pg.Pool | undefined;
    try {
      await admin.query(`CREATE DATABASE "${name}"`); created = true;
      connection.pathname = `/${name}`; pool = new pg.Pool({ connectionString: connection.href });
      // Only actual account/RBAC schema, no token/password issuer tables.
      for (const sql of AUTH_SCHEMA_SQL.slice(0, 8)) await pool.query(sql);
      const preference = splitPostgresSqlStatements(readFileSync(new URL('../../../../../drizzle/control-plane/0000_control_plane.sql', import.meta.url), 'utf8'))
        .find(sql => /^CREATE TABLE "user_preferences"/u.test(sql.trim()));
      expect(preference).toBeTruthy(); await pool.query(preference!);
      await pool.query("INSERT INTO users(id,status,created_at,updated_at) VALUES('preserved','active','before','before')");
      await pool.query("INSERT INTO roles(id,key,created_at) VALUES('role','member','before')");
      await pool.query("INSERT INTO permissions(id,key,resource,action,scope,created_at) VALUES('permission','services:manage:team','services','manage','team','before')");
      await pool.query("INSERT INTO role_permissions(role_id,permission_id,created_at) VALUES('role','permission','before')");
      await pool.query("INSERT INTO user_role_bindings(id,user_id,role_id,created_at) VALUES('binding','preserved','role','before')");
      const store = createIdentityPrincipalStore({ transaction: async <T>(run: (client: pg.PoolClient) => Promise<T>) => {
        const client = await pool!.connect();
        try { await client.query('BEGIN'); const value = await run(client); await client.query('COMMIT'); return value; }
        catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      } });
      expect((await store.principalForUser('preserved')).principal.scopes).toEqual(['treeseed:read', 'treeseed:projects:write']);
      await expect(store.first("UPDATE users SET status='disabled' RETURNING id")).rejects.toThrow('Identity authorization unavailable');
      expect((await pool.query("SELECT status FROM users WHERE id='preserved'")).rows[0].status).toBe('active');
      await pool.query('DELETE FROM user_role_bindings');
      const revoked = await store.principalForUser('preserved');
      expect(revoked.principal.roles).toEqual([]); expect(revoked.principal.permissions).toEqual([]);
      expect(revoked.principal.scopes).toEqual(['treeseed:read']);
      expect((await pool.query("SELECT to_regclass('api_tokens') AS tokens,to_regclass('auth_sessions') AS sessions,to_regclass('control_plane_auth_credentials') AS passwords")).rows[0])
        .toEqual({ tokens: null, sessions: null, passwords: null });
      await pool.query("UPDATE users SET status='disabled'");
      await expect(store.principalForUser('preserved')).rejects.toThrow('Identity authorization unavailable');
    } finally {
      await pool?.end(); if (created) await admin.query(`DROP DATABASE "${name}"`); await admin.end();
    }
  });
});
