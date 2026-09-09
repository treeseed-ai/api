import type { PoolClient } from 'pg';
import type { ApiPrincipal } from '../../types.ts';
import { authorizedIdentityScopes } from './authorized-scopes.ts';

export interface IdentityPrincipalStore {
  first<T>(sql: string, parameters?: unknown[]): Promise<T | null>;
  principalForUser(userId: string): Promise<{ userId: string; principal: ApiPrincipal }>;
}
interface Database { transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> }

/** Read-only local authorization, independent of the retired token/password
 * issuer. Schema creation and account enrollment are never authentication work.
 */
export function createIdentityPrincipalStore(database: Database): IdentityPrincipalStore {
  const read = async <T>(run: (client: PoolClient) => Promise<T>) => {
    try { return await database.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      return run(client);
    }); } catch { throw new Error('Identity authorization unavailable'); }
  };
  return {
    first: <T>(sql: string, parameters: unknown[] = []) => read(async client => {
      // Queries are internal fixed API statements, never a caller-supplied SQL surface.
      let index = 0;
      return (await client.query(sql.replace(/\?/gu, () => `$${++index}`), parameters)).rows[0] as T ?? null;
    }),
    principalForUser: userId => read(async client => {
      const user = (await client.query('SELECT id,status,display_name,metadata_json,email,username FROM users WHERE id=$1 AND status=\'active\'', [userId])).rows[0];
      if (!user) throw new Error('Active mapped user required');
      const roleRows = await client.query(`SELECT roles.key FROM user_role_bindings
        JOIN roles ON roles.id=user_role_bindings.role_id WHERE user_role_bindings.user_id=$1`, [userId]);
      const permissionRows = await client.query(`SELECT DISTINCT permissions.key FROM user_role_bindings
        JOIN role_permissions ON role_permissions.role_id=user_role_bindings.role_id
        JOIN permissions ON permissions.id=role_permissions.permission_id WHERE user_role_bindings.user_id=$1`, [userId]);
      const preferences = (await client.query('SELECT color_scheme,theme_mode FROM user_preferences WHERE user_id=$1 LIMIT 1', [userId])).rows[0];
      const keys = (rows: Record<string, unknown>[]) => rows.map(row => {
        if (typeof row.key !== 'string' || !row.key) throw new Error('Invalid local authorization record');
        return row.key;
      });
      const roles = keys(roleRows.rows), permissions = keys(permissionRows.rows);
      const metadata = user.metadata_json ? JSON.parse(user.metadata_json) : {};
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid local account metadata');
      return { userId, principal: { id: user.id, displayName: user.display_name ?? undefined, roles, permissions,
        scopes: authorizedIdentityScopes(permissions), metadata: { ...metadata,
          appearance: preferences ? { ...(metadata.appearance && typeof metadata.appearance === 'object' ? metadata.appearance : {}),
            scheme: preferences.color_scheme ?? 'fern', mode: preferences.theme_mode ?? 'system' } : metadata.appearance,
          email: user.email ?? undefined, username: user.username ?? undefined } } };
    }),
  };
}
