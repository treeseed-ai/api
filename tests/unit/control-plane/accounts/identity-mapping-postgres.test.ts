import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { AUTH_SCHEMA_SQL } from '../../../../src/api/auth/postgres-store.ts';
import { planIdentityMappings } from '../../../../src/api/auth/identity-mapping-plan.ts';
import { applyIdentityMappings } from '../../../../src/api/auth/identity-mapping-transaction.ts';

const url = process.env.TREESEED_TEST_POSTGRES_URL;
describe.skipIf(!url)('transactional identity mapping in real PostgreSQL', () => {
  it('preserves IDs, rejects stale plans, replays noop and rolls back partial inserts', async () => {
    const connection = new URL(url!);
    if (!['127.0.0.1', 'localhost'].includes(connection.hostname) || connection.pathname !== '/postgres') throw new Error('Use an explicit disposable local PostgreSQL service');
    const admin = new pg.Pool({ connectionString: connection.href });
    const name = `treeseed_identity_test_${randomUUID().replaceAll('-', '')}`;
    let pool: pg.Pool | undefined;
    let created = false;
    try {
      await admin.query(`CREATE DATABASE "${name}"`); created = true;
      connection.pathname = `/${name}`;
      pool = new pg.Pool({ connectionString: connection.href });
      for (const sql of AUTH_SCHEMA_SQL.slice(0, 3)) await pool.query(sql);
      await pool.query(readFileSync('drizzle/control-plane/0020_identity_workloads.sql', 'utf8'));
      await pool.query("INSERT INTO users(id,status,created_at,updated_at) VALUES ('preserved','active','now','now')");
      const database = { transaction: async <T>(run: (client: pg.PoolClient) => Promise<T>) => {
        const client = await pool!.connect();
        try { await client.query('BEGIN'); const result = await run(client); await client.query('COMMIT'); return result; }
        catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      } };
      const inventory = async () => ({ users: (await pool!.query('SELECT id,status FROM users')).rows,
        mappings: (await pool!.query('SELECT user_id AS "userId",provider AS issuer,provider_subject AS subject FROM user_identities')).rows,
        workloads: (await pool!.query('SELECT id,issuer,subject FROM identity_workloads')).rows });
      const mapping = { userId: 'preserved', issuer: 'https://identity.example.test', subject: 'first' };
      const initial = planIdentityMappings(await inventory(), [mapping]);
      await pool.query("UPDATE users SET status='disabled'");
      await expect(applyIdentityMappings(database, { requested: [], ...initial })).rejects.toThrow('inventory or request changed');
      await pool.query("UPDATE users SET status='active'");
      await expect(applyIdentityMappings(database, { requested: [{ ...mapping, subject: 'changed' }], ...initial })).rejects.toThrow('inventory or request changed');
      await pool.query(`INSERT INTO identity_workloads(id,issuer,subject,client_id,display_name,status) VALUES ('service',$1,$2,'client','Service','revoked')`, [mapping.issuer,mapping.subject]);
      await expect(applyIdentityMappings(database, { requested: [mapping], ...initial })).rejects.toThrow('workload identity');
      await pool.query("DELETE FROM identity_workloads WHERE id='service'");
      await applyIdentityMappings(database, { requested: [mapping], ...initial });
      const replay = planIdentityMappings(await inventory(), [mapping]);
      expect((await applyIdentityMappings(database, { requested: [mapping], ...replay })).operations[0].action).toBe('noop');
      await pool.query("ALTER TABLE user_identities ADD CONSTRAINT reject_test_subject CHECK (provider_subject <> 'z-rejected')");
      const requested = [{ ...mapping, subject: 'a-inserted' }, { ...mapping, subject: 'z-rejected' }];
      const batch = planIdentityMappings(await inventory(), requested);
      await expect(applyIdentityMappings(database, { requested, ...batch })).rejects.toThrow();
      expect((await inventory()).mappings).toEqual([mapping]);
      expect((await inventory()).users).toEqual([{ id: 'preserved', status: 'active' }]);
    } finally {
      await pool?.end();
      if (created) await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    }
  });
});
