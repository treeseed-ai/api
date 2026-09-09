import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { AUTH_SCHEMA_SQL } from '../../../../../src/api/auth/postgres-store.ts';
import { planIdentityWorkloads } from '../../../../../src/api/auth/identity-workload-plan.ts';
import { applyIdentityWorkloads } from '../../../../../src/api/auth/identity-workload-transaction.ts';

const url = process.env.TREESEED_TEST_POSTGRES_URL;
describe.skipIf(!url)('transactional workload registration in disposable PostgreSQL', () => {
  it('binds both digests, preserves IDs, rejects human/revoked state and rolls back a batch', async () => {
    const connection = new URL(url!);
    if (!['127.0.0.1', 'localhost'].includes(connection.hostname) || connection.pathname !== '/postgres') throw new Error('Disposable local PostgreSQL required');
    const admin = new pg.Pool({ connectionString: connection.href });
    const name = `treeseed_workload_test_${randomUUID().replaceAll('-', '')}`;
    let pool: pg.Pool | undefined, created = false;
    try {
      await admin.query(`CREATE DATABASE "${name}"`); created = true; connection.pathname = `/${name}`;
      pool = new pg.Pool({ connectionString: connection.href });
      for (const sql of AUTH_SCHEMA_SQL.slice(0, 3)) await pool.query(sql);
      await pool.query(readFileSync('drizzle/control-plane/0020_identity_workloads.sql', 'utf8'));
      const database = { transaction: async <T>(run: (client: pg.PoolClient) => Promise<T>) => {
        const client = await pool!.connect();
        try { await client.query('BEGIN'); const result = await run(client); await client.query('COMMIT'); return result; }
        catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      } };
      const inventory = async () => ({
        workloads: (await pool!.query(`SELECT id,issuer,subject,client_id AS "clientId",display_name AS "displayName",status,permissions,scopes FROM identity_workloads`)).rows,
        humans: (await pool!.query(`SELECT users.id AS "userId",COALESCE(provider,'') AS issuer,COALESCE(provider_subject,'') AS subject FROM users LEFT JOIN user_identities ON users.id=user_identities.user_id`)).rows,
      });
      const value = { id: 'service', issuer: 'https://identity.example.test', subject: 'verified', clientId: 'admin-bff',
        displayName: 'Admin', permissions: ['auth:read:self'], scopes: ['treeseed:read'] };
      const plan = planIdentityWorkloads(await inventory(), [value]);
      await expect(applyIdentityWorkloads(database, { ...plan, requested: [{ ...value, permissions: ['*:*:*'] }] })).rejects.toThrow('plan changed');
      await pool.query("INSERT INTO users(id,status,created_at,updated_at) VALUES ('human','active','now','now')");
      await expect(applyIdentityWorkloads(database, { ...plan, requested: [value] })).rejects.toThrow('plan changed');
      const current = planIdentityWorkloads(await inventory(), [value]);
      expect((await applyIdentityWorkloads(database, { ...current, requested: [value] })).operations[0].action).toBe('register');
      const replay = planIdentityWorkloads(await inventory(), [value]);
      expect((await applyIdentityWorkloads(database, { ...replay, requested: [value] })).operations[0].action).toBe('noop');
      await pool.query("UPDATE identity_workloads SET status='revoked'");
      await expect(applyIdentityWorkloads(database, { ...replay, requested: [value] })).rejects.toThrow('revocation');
      await pool.query("ALTER TABLE identity_workloads ADD CONSTRAINT reject_test_subject CHECK (subject <> 'z-rejected')");
      const requested = [{ ...value, id: 'a-new', subject: 'a-new', clientId: 'a-new' }, { ...value, id: 'z-new', subject: 'z-rejected', clientId: 'z-new' }];
      const batch = planIdentityWorkloads(await inventory(), requested);
      await expect(applyIdentityWorkloads(database, { ...batch, requested })).rejects.toThrow();
      expect((await inventory()).workloads).toEqual([{ ...value, status: 'revoked' }]);
      const human = { ...value, id: 'human' };
      await expect(applyIdentityWorkloads(database, { ...batch, requested: [human] })).rejects.toThrow('human');
    } finally { await pool?.end(); if (created) await admin.query(`DROP DATABASE "${name}"`); await admin.end(); }
  });
});
