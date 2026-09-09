import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { createIdentityPrincipalStore } from '../../../../../src/api/auth/identity/principal-store.ts';
import { authorizedIdentityScopes } from '../../../../../src/api/auth/identity/authorized-scopes.ts';

function setup(active = true) {
  const query = vi.fn(async (sql: string, _parameters?: unknown[]) => {
    if (sql.startsWith('SET TRANSACTION')) return { rows: [] };
    if (sql.includes('FROM users')) return { rows: active ? [{ id: 'preserved', status: 'active', display_name: 'Existing', metadata_json: '{"appearance":{"contrast":"high"}}' }] : [] };
    if (sql.includes('DISTINCT permissions')) return { rows: [{ key: 'services:manage:team' }] };
    if (sql.includes('roles.key')) return { rows: [{ key: 'member' }] };
    if (sql.includes('user_preferences')) return { rows: [{ color_scheme: 'fern', theme_mode: 'dark' }] };
    return { rows: [{ user_id: 'preserved' }] };
  });
  const transaction = vi.fn(async <T>(run: (client: PoolClient) => Promise<T>) => run({ query } as unknown as PoolClient));
  return { query, transaction, store: createIdentityPrincipalStore({ transaction }) };
}
describe('Identity local authorization without a password/token issuer', () => {
  it('reads a consistent local principal without writing or initializing schemas', async () => {
    const f = setup(); const result = await f.store.principalForUser('preserved');
    expect(result.userId).toBe('preserved');
    expect(result.principal.roles).toEqual(['member']);
    expect(result.principal.permissions).toEqual(['services:manage:team']);
    expect(result.principal.scopes).toEqual(['treeseed:read', 'treeseed:projects:write']);
    expect(result.principal.metadata?.appearance).toEqual({ contrast: 'high', scheme: 'fern', mode: 'dark' });
    expect(f.transaction).toHaveBeenCalledTimes(1);
    expect(f.query.mock.calls[0]?.[0]).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (const [sql, params] of f.query.mock.calls.slice(1)) {
      expect(sql).toMatch(/^SELECT/); expect(params).toEqual(['preserved']);
      expect(sql).not.toMatch(/api_tokens|auth_sessions|auth_credentials|service_credentials/);
    }
    expect(Object.keys(f.store).sort()).toEqual(['first', 'principalForUser']);
  });
  it('denies inactive or missing users before reading their grants', async () => {
    const f = setup(false); await expect(f.store.principalForUser('disabled')).rejects.toThrow('Identity authorization unavailable');
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.query.mock.calls[1]?.[0]).toContain("status='active'");
  });
  it('uses bound issuer/subject parameters and redacts database errors', async () => {
    const f = setup();
    expect(await f.store.first('SELECT user_id FROM user_identities WHERE provider=? AND provider_subject=?', ['issuer', 'subject'])).toEqual({ user_id: 'preserved' });
    expect(f.query.mock.calls[1]).toEqual(['SELECT user_id FROM user_identities WHERE provider=$1 AND provider_subject=$2', ['issuer', 'subject']]);
    f.query.mockRejectedValueOnce(new Error('private database connection detail'));
    await expect(f.store.first('SELECT id FROM users')).rejects.toThrow('Identity authorization unavailable');
  });
  it('keeps scope ceilings identical while local resource grants stay separate', () => {
    expect(authorizedIdentityScopes([])).toEqual(['treeseed:read']);
    expect(authorizedIdentityScopes(['knowledge:read'])).toEqual(['treeseed:read']);
    expect(authorizedIdentityScopes(['*:*:*'])).toEqual(['treeseed:read', 'treeseed:knowledge:write', 'treeseed:governance:write', 'treeseed:projects:write', 'treeseed:execution', 'treeseed:admin']);
  });
});
