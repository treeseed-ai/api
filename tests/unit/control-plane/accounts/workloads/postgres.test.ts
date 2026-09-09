import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { AUTH_SCHEMA_SQL } from '../../../../../src/api/auth/postgres-store.ts';
import { createIdentityAuthenticator } from '../../../../../src/api/auth/identity-authenticator.ts';

const url = process.env.TREESEED_TEST_POSTGRES_URL;
describe.skipIf(!url)('workload registration in disposable PostgreSQL', () => {
  it('enforces unique registrations, revocation, scope limits and human collision denial', async () => {
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
      const issuer = 'https://identity.example.test', audience = 'https://api.example.test';
      await pool.query(`INSERT INTO identity_workloads(id,issuer,subject,client_id,display_name,permissions,scopes)
        VALUES ('preserved',$1,'service-subject','admin-bff','Admin','["auth:read:self"]','["treeseed:read"]')`, [issuer]);
      await expect(pool.query(`INSERT INTO identity_workloads(id,issuer,subject,client_id,display_name)
        VALUES ('collision',$1,'service-subject','other','Other')`, [issuer])).rejects.toThrow();
      const keys = await generateKeyPair('RS256');
      const authenticate = createIdentityAuthenticator({ issuer, audience, verificationKey: keys.publicKey, store: {
        first: async (sql: string, values: unknown[]) => { let index = 0; return (await pool!.query(sql.replace(/\?/gu, () => `$${++index}`), values)).rows[0] ?? null; },
        principalForUser: async () => { throw new Error('Workload must not load human authority'); },
      } as any });
      const token = await new SignJWT({ typ: 'Bearer', azp: 'admin-bff', scope: 'treeseed:read treeseed:execution' })
        .setProtectedHeader({ alg: 'RS256' }).setIssuer(issuer).setAudience(audience).setSubject('service-subject')
        .setIssuedAt().setExpirationTime('1m').sign(keys.privateKey);
      expect((await authenticate(token)).principal.scopes).toEqual(['treeseed:read']);
      await pool.query("UPDATE identity_workloads SET status='revoked'"); await expect(authenticate(token)).rejects.toThrow();
      await pool.query("UPDATE identity_workloads SET status='active',client_id='rotated'"); await expect(authenticate(token)).rejects.toThrow();
      await pool.query("UPDATE identity_workloads SET client_id='admin-bff'");
      await pool.query("INSERT INTO users(id,status,created_at,updated_at) VALUES ('human','active','now','now')");
      await pool.query("INSERT INTO user_identities(id,user_id,provider,provider_subject,created_at,updated_at) VALUES ('mapping','human',$1,'service-subject','now','now')", [issuer]);
      await expect(authenticate(token)).rejects.toThrow();
    } finally { await pool?.end(); if (created) await admin.query(`DROP DATABASE "${name}"`); await admin.end(); }
  });
});
