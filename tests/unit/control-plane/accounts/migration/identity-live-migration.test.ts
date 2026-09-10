import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { migrateLiveIdentity } from '../../../../../src/api/auth/identity/live-migration.ts';

const issuer = 'https://identity.example.test/realms/treeseed';
const resource = 'https://api.example.test';
const hash = `pbkdf2-sha256$210000$${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(32).toString('base64url')}`;
const user = () => ({ id: 'existing-user', status: 'active', username: 'existing-user', email: 'user@example.test',
  verified: true, password_hash: hash as string | null, subject: null as string | null });

function fixture(users = [user()]) {
  const mappings: Array<{ userId: string; issuer: string; subject: string }> = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('COALESCE(c.username')) return { rows: users };
    if (sql.includes('INSERT INTO user_identities')) {
      mappings.push({ userId: values![1] as string, issuer: values![2] as string, subject: values![3] as string });
      users.find(item => item.id === values![1])!.subject = values![3] as string;
      return { rows: [] };
    }
    if (sql.includes('LEFT JOIN user_identities')) return { rows: users.map(item => ({ userId: item.id, issuer, subject: item.subject ?? '' })) };
    if (sql.includes('FROM user_identities')) return { rows: mappings };
    if (sql.includes('FROM users')) return { rows: users.map(({ id, status }) => ({ id, status })) };
    return { rows: [] };
  });
  return { query, database: { transaction: async <T>(run: (client: PoolClient) => Promise<T>) => run({ query } as unknown as PoolClient) } };
}

describe('stopped-writer Identity migration', () => {
  it('preserves local IDs, imports verified hash metadata, and repeats without reimport', async () => {
    const { database, query } = fixture();
    const importAccount = vi.fn(async account => {
      expect(account.sourceUserId).toBe('existing-user');
      expect(account.emailVerified).toBe(true);
      expect(JSON.parse(account.credential.credentialData).algorithm).toBe('pbkdf2-sha256');
      return { issuer, subject: 'issuer-user', sourceUserId: account.sourceUserId };
    });
    const input = { issuer, resource, backupGeneration: 42, workloads: [], importAccount };
    expect(await migrateLiveIdentity(database, input)).toEqual({ imported: 1, preserved: 0, workloads: 0 });
    expect(await migrateLiveIdentity(database, input)).toEqual({ imported: 0, preserved: 1, workloads: 0 });
    expect(importAccount).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO user_identities'))).toHaveLength(1);
    expect(query.mock.calls.some(([sql]) => /DELETE|UPDATE users/u.test(sql))).toBe(false);
  });
  it('requires a restore point before any issuer mutation', async () => {
    const { database } = fixture(), importAccount = vi.fn();
    await expect(migrateLiveIdentity(database, { issuer, resource, workloads: [], importAccount })).rejects.toThrow('restore point');
    expect(importAccount).not.toHaveBeenCalled();
  });
  it('validates every hash before importing the first account', async () => {
    const { database } = fixture([user(), { ...user(), id: 'second', password_hash: 'unsupported' }]);
    const importAccount = vi.fn();
    await expect(migrateLiveIdentity(database, { issuer, resource, backupGeneration: 42, workloads: [], importAccount })).rejects.toThrow('password reset');
    expect(importAccount).not.toHaveBeenCalled();
  });
  it('rejects changed source authority without committing an identity mapping', async () => {
    const { database, query } = fixture();
    const importAccount = vi.fn(async () => ({ issuer, subject: 'issuer-user', sourceUserId: 'another-user' }));
    await expect(migrateLiveIdentity(database, { issuer, resource, backupGeneration: 42, workloads: [], importAccount })).rejects.toThrow('source authority');
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false);
  });
});
