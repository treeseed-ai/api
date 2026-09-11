import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { BrowserEnrollmentProfile } from '@treeseed/identity';

interface Database { transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> }

/** Called only from Identity's validated interactive callback. Never an API
 * endpoint, email account linker, refresh hook or general token authenticator. */
export async function enrollBrowserIdentity(database: Database, issuer: string, profile: BrowserEnrollmentProfile) {
  if (profile.identity.issuer !== issuer || !profile.identity.subject) throw new Error('Managed browser identity required');
  return database.transaction(async client => {
    await client.query("SET LOCAL lock_timeout = '5s'");
    // Serializes both simultaneous first logins and maintenance mapping changes.
    await client.query('LOCK TABLE users, user_identities, identity_workloads IN SHARE ROW EXCLUSIVE MODE');
    const binding = [issuer, profile.identity.subject];
    if ((await client.query('SELECT id FROM identity_workloads WHERE issuer=$1 AND subject=$2', binding)).rows.length)
      throw new Error('Workload identity cannot enroll as a user');
    const existing = (await client.query(`SELECT users.id,users.status FROM user_identities identities
      JOIN users ON users.id=identities.user_id WHERE identities.provider=$1 AND identities.provider_subject=$2`, binding)).rows[0];
    if (existing) {
      if (existing.status !== 'active') throw new Error('Account is not active');
      return { action: 'noop' as const, userId: existing.id as string };
    }
    if (!profile.emailVerified || !profile.email) throw new Error('Verify your email before creating an account');
    const id = randomUUID(), now = new Date().toISOString();
    const name = profile.displayName ?? ([profile.firstName, profile.lastName].filter(Boolean).join(' ') || null);
    await client.query(`INSERT INTO users (id,email,display_name,status,metadata_json,created_at,updated_at)
      VALUES ($1,$2,$3,'active',$4,$5,$5)`, [id, profile.email, name,
      JSON.stringify({ identity: { firstName: profile.firstName, lastName: profile.lastName } }), now]);
    await client.query(`INSERT INTO user_identities
      (id,user_id,provider,provider_subject,email,email_verified,profile_json,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,1,$6,$7,$7)`, [randomUUID(), id, issuer, profile.identity.subject, profile.email,
      JSON.stringify({ firstName: profile.firstName, lastName: profile.lastName }), now]);
    // Same baseline role as ordinary account creation, never an issuer role or
    // team/organization membership. Authorization remains application-owned.
    await client.query(`INSERT INTO user_role_bindings (id,user_id,role_id,created_at)
      SELECT $1,$2,id,$3 FROM roles WHERE key='member' ON CONFLICT DO NOTHING`, [randomUUID(), id, now]);
    return { action: 'created' as const, userId: id };
  });
}
