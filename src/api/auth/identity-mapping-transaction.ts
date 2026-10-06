import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { planIdentityMappings, type IdentityMapping } from './identity-mapping-plan.ts';

interface MappingDatabase { transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> }

/** Internal migration primitive, not an account-linking endpoint. The orchestrator
 * must authorize the import and establish a coordinated restore point first. */
export async function applyIdentityMappings(database: MappingDatabase, input: {
  requested: IdentityMapping[]; inventoryDigest: string; requestDigest: string;
}) {
  return database.transaction(async client => {
    // Lock human and workload inventory, including legacy inserts/updates. Keep
    // this maintenance transaction short; no network calls while locks are held.
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('LOCK TABLE users, user_identities, identity_workloads IN SHARE ROW EXCLUSIVE MODE');
    const users = await client.query('SELECT id, status FROM users');
    const mappings = await client.query('SELECT user_id AS "userId", provider AS issuer, provider_subject AS subject FROM user_identities');
    const workloads = await client.query('SELECT id,issuer,subject FROM identity_workloads');
    const plan = planIdentityMappings({ users: users.rows, mappings: mappings.rows, workloads: workloads.rows }, input.requested);
    if (plan.inventoryDigest !== input.inventoryDigest || plan.requestDigest !== input.requestDigest)
      throw new Error('Identity inventory or request changed; create a new mapping plan');
    const now = new Date().toISOString();
    for (const mapping of plan.operations) {
      if (mapping.action === 'noop') continue;
      await client.query(`INSERT INTO user_identities
        (id, user_id, provider, provider_subject, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $5)`,
      [randomUUID(), mapping.userId, mapping.issuer, mapping.subject, now]);
    }
    return plan;
  });
}
