import type { PoolClient } from 'pg';
import type { KeycloakAccountImport } from '@treeseed/identity';
import { prepareIdentityPasswordImport } from '../identity-password-import.ts';
import { planIdentityMappings, type IdentityMapping } from '../identity-mapping-plan.ts';
import { applyIdentityMappings } from '../identity-mapping-transaction.ts';
import { planIdentityWorkloads, type IdentityWorkloadRegistration } from './workload-plan.ts';
import { applyIdentityWorkloads } from './workload-transaction.ts';

interface Database { transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> }
interface ExistingUser { id: string; status: string; username: string | null; email: string | null;
  verified: boolean; password_hash: string | null; subject: string | null }

/** Only the stopped-writer migration job invokes this orchestrator. Existing
 * IDs/memberships stay in place; no network calls run while DB locks are held.
 * Hashes remain inside this maintenance process and the verified issuer link.
 */
export async function migrateLiveIdentity(database: Database, input: {
  issuer: string; resource: string; backupGeneration?: number; workloads: IdentityWorkloadRegistration[];
  importAccount(account: KeycloakAccountImport): Promise<{ issuer: string; subject: string; sourceUserId: string }>;
}) {
  const users = await database.transaction(async client => (await client.query<ExistingUser>(`
    SELECT u.id,u.status,COALESCE(c.username,u.username) AS username,COALESCE(c.email,u.email) AS email,
      c.password_hash,EXISTS(SELECT 1 FROM user_email_addresses e WHERE e.user_id=u.id AND e.status='verified'
        AND e.normalized_email=lower(COALESCE(c.email,u.email))) AS verified,
      (SELECT i.provider_subject FROM user_identities i WHERE i.user_id=u.id AND i.provider=$1 LIMIT 1) AS subject
    FROM users u LEFT JOIN control_plane_auth_credentials c ON c.user_id=u.id AND c.status='active'
    WHERE u.status='active' ORDER BY u.id LIMIT 10001`, [input.issuer])).rows);
  if (users.length > 10000) throw new Error('Identity migration requires a bounded account batch');
  const pending = users.filter(user => !user.subject);
  if (pending.length && (!Number.isSafeInteger(input.backupGeneration) || input.backupGeneration! < 1))
    throw new Error('Existing accounts require a coordinated restore point before Identity import');
  // Validate the entire batch before sending any account to the issuer.
  const accounts = pending.map(user => {
    if (!user.email) throw new Error('Existing account requires Identity recovery before cutover');
    return { sourceResource: input.resource, sourceUserId: user.id, username: user.username || user.email,
      email: user.email, emailVerified: user.verified, credential: prepareIdentityPasswordImport(user.password_hash) };
  });
  const requested: IdentityMapping[] = [];
  try {
    for (const account of accounts) {
      const observed = await input.importAccount(account);
      if (observed.issuer !== input.issuer || observed.sourceUserId !== account.sourceUserId)
        throw new Error('Identity import returned a different source authority');
      requested.push({ userId: account.sourceUserId, issuer: observed.issuer, subject: observed.subject });
    }
    const mapping = await database.transaction(async client => planIdentityMappings({
      users: (await client.query('SELECT id,status FROM users')).rows,
      mappings: (await client.query('SELECT user_id AS "userId",provider AS issuer,provider_subject AS subject FROM user_identities')).rows,
      workloads: (await client.query('SELECT id,issuer,subject FROM identity_workloads')).rows,
    }, requested));
    await applyIdentityMappings(database, { ...mapping, requested });
    const workloadPlan = await database.transaction(async client => planIdentityWorkloads({
      workloads: (await client.query('SELECT id,issuer,subject,client_id AS "clientId",display_name AS "displayName",status,permissions,scopes FROM identity_workloads')).rows,
      humans: (await client.query(`SELECT users.id AS "userId",COALESCE(provider,'') AS issuer,COALESCE(provider_subject,'') AS subject
        FROM users LEFT JOIN user_identities ON users.id=user_identities.user_id`)).rows,
    }, input.workloads));
    await applyIdentityWorkloads(database, { ...workloadPlan, requested: input.workloads });
    return { imported: requested.length, preserved: users.length - requested.length,
      workloads: workloadPlan.operations.filter(value => value.action === 'register').length };
  } finally {
    // Strings cannot be zeroed, but keep neither hash/verifier in retained records.
    for (const user of users) user.password_hash = null;
    for (const account of accounts) { account.credential.secretData = ''; account.credential.credentialData = ''; }
  }
}
