import { it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { enrollBrowserIdentity } from '../../../../../src/api/auth/identity/browser-enrollment.ts';

const issuer = 'https://identity.example/realms/team';
const profile = { identity: { issuer, subject: 'new-subject' }, email: 'same@example.test', emailVerified: true, firstName: 'New', lastName: 'Person' };
function fixture(existing?: { id: string; status: string }, workload = false) {
  const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith('SELECT id FROM identity_workloads') ? workload ? [{ id: 'service' }] : []
    : sql.startsWith('SELECT users.id') && existing ? [existing] : [] }));
  const database = { transaction: async <T>(run: (client: PoolClient) => Promise<T>) => run({ query } as unknown as PoolClient) };
  return { query, database };
}
it('creates a distinct principal and exact subject mapping without searching by email or assigning team authority', async () => {
  const f = fixture(); const result = await enrollBrowserIdentity(f.database, issuer, profile);
  expect(result.action).toBe('created');
  const sql = f.query.mock.calls.map(call => call[0]).join('\n');
  expect(sql).toContain('LOCK TABLE users, user_identities, identity_workloads');
  expect(sql).toContain('INSERT INTO users'); expect(sql).toContain('INSERT INTO user_identities');
  expect(sql).not.toMatch(/WHERE email|team_memberships|organization_memberships|admin/);
  expect(sql).toContain("WHERE key='member'");
});
it('preserves active mapped IDs and rejects blocked accounts, workloads, unverified registrations and wrong issuer', async () => {
  const f = fixture({ id: 'preserved-id', status: 'active' });
  expect(await enrollBrowserIdentity(f.database, issuer, profile)).toEqual({ action: 'noop', userId: 'preserved-id' });
  expect(f.query.mock.calls.some(call => call[0].startsWith('INSERT'))).toBe(false);
  for (const [state, input] of [
    [fixture({ id: 'blocked', status: 'disabled' }), profile], [fixture(undefined, true), profile],
    [fixture(), { ...profile, emailVerified: false }], [fixture(), { ...profile, identity: { ...profile.identity, issuer: 'https://untrusted.example' } }],
  ] as const) {
    await expect(enrollBrowserIdentity(state.database, issuer, input)).rejects.toThrow();
    expect(state.query.mock.calls.some(call => call[0].startsWith('INSERT'))).toBe(false);
  }
});
