import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { EncryptedEnvelopeCodec, StaticEnvelopeKeyProvider } from '@treeseed/sdk/security';
import { AUTH_SCHEMA_SQL } from '../../../../src/api/auth/postgres-store.ts';
import { BrowserSessionStore } from '../../../../src/api/auth/browser-session-store.ts';

const url = process.env.TREESEED_TEST_POSTGRES_URL;
describe.skipIf(!url)('encrypted browser sessions in real PostgreSQL', () => {
  it('isolates clients, binds metadata, serializes refresh and revokes ambiguous exchanges', async () => {
    const connection = new URL(url!);
    if (!['127.0.0.1', 'localhost'].includes(connection.hostname) || connection.pathname !== '/postgres') throw new Error('Use an explicit disposable local PostgreSQL service');
    const admin = new pg.Pool({ connectionString: connection.href });
    const name = `treeseed_bff_test_${randomUUID().replaceAll('-', '')}`;
    let pool: pg.Pool | undefined, created = false;
    try {
      await admin.query(`CREATE DATABASE "${name}"`); created = true;
      connection.pathname = `/${name}`; pool = new pg.Pool({ connectionString: connection.href });
      for (const sql of AUTH_SCHEMA_SQL.slice(0, 3)) await pool.query(sql);
      await pool.query("INSERT INTO users(id,status,created_at,updated_at) VALUES ('preserved','active','now','now')");
      await pool.query("INSERT INTO user_identities(id,user_id,provider,provider_subject,created_at,updated_at) VALUES ('mapping','preserved','https://id.example.test','subject','now','now')");
      await pool.query(readFileSync('drizzle/control-plane/0019_identity_browser_sessions.sql', 'utf8'));
      const database = { transaction: async <T>(run: (client: pg.PoolClient) => Promise<T>) => {
        const client = await pool!.connect();
        try { await client.query('BEGIN'); const result = await run(client); await client.query('COMMIT'); return result; }
        catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
        finally { client.release(); }
      } };
      const codec = new EncryptedEnvelopeCodec(new StaticEnvelopeKeyProvider('systemd-credential', { id: 'browser-session', version: 1, key: randomBytes(32) }));
      const app = new BrowserSessionStore(database, codec, 'admin');
      const other = new BrowserSessionStore(database, codec, 'market');
      const input = { issuer: 'https://id.example.test', subject: 'subject', userId: 'preserved', expiresAt: new Date(Date.now() + 60000),
        tokens: { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh-0', resource: 'https://api.example.test', accessExpiresAt: Date.now() + 30000 } };
      await expect(app.create({ ...input, subject: 'not-mapped' })).rejects.toThrow('Active mapped user');
      const session = await app.create(input);
      const stored = JSON.stringify((await pool.query('SELECT * FROM identity_browser_sessions')).rows);
      expect(stored).not.toContain('synthetic-access'); expect(stored).not.toContain('synthetic-refresh'); expect(stored).not.toContain(session.handle);
      expect(await other.use(session.handle, async () => { throw new Error('Must not run'); })).toBeNull();
      await other.remove(session.handle);
      const seen: string[] = [];
      await Promise.all([1, 2].map(() => app.use(session.handle, async tokens => {
        seen.push(tokens.refreshToken!);
        return { result: true, tokens: { ...tokens, refreshToken: `synthetic-refresh-${seen.length}` } };
      })));
      expect(seen).toEqual(['synthetic-refresh-0', 'synthetic-refresh-1']);
      await pool.query("UPDATE identity_browser_sessions SET expires_at=expires_at+interval '1 minute'");
      await expect(app.use(session.handle, async () => ({ result: true }))).rejects.toThrow('sign in again');
      await app.remove(session.handle);
      const fresh = await app.create(input);
      await expect(app.use(fresh.handle, async () => { throw new Error('ambiguous refresh'); })).rejects.toThrow('sign in again');
      expect(await app.use(fresh.handle, async () => ({ result: true }))).toBeNull();
      const disabled = await app.create(input);
      await pool.query("UPDATE users SET status='disabled'");
      expect(await app.use(disabled.handle, async () => ({ result: true }))).toBeNull();
      await pool.query("UPDATE users SET status='active'");
      const unlinked = await app.create(input);
      await pool.query("DELETE FROM user_identities WHERE id='mapping'");
      expect(await app.use(unlinked.handle, async () => { throw new Error('Unlinked identity must never receive tokens'); })).toBeNull();
    } finally {
      await pool?.end();
      if (created) await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    }
  });
});
