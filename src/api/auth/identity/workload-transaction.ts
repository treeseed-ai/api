import type { PoolClient } from 'pg';
import { planIdentityWorkloads, type IdentityWorkloadRegistration } from './workload-plan.ts';

interface Database { transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> }
/** Privileged migration only, not a public registration endpoint. The caller
 * verifies the issuer's service subject and coordinated restore point first.
 */
export async function applyIdentityWorkloads(database: Database, input: {
  requested: IdentityWorkloadRegistration[]; inventoryDigest: string; requestDigest: string;
}) {
  return database.transaction(async client => {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('LOCK TABLE users, user_identities, identity_workloads IN SHARE ROW EXCLUSIVE MODE');
    const workloads = await client.query(`SELECT id,issuer,subject,client_id AS "clientId",display_name AS "displayName",status,permissions,scopes FROM identity_workloads`);
    const humans = await client.query(`SELECT users.id AS "userId",COALESCE(provider,'') AS issuer,COALESCE(provider_subject,'') AS subject
      FROM users LEFT JOIN user_identities ON users.id=user_identities.user_id`);
    const plan = planIdentityWorkloads({ workloads: workloads.rows, humans: humans.rows }, input.requested);
    if (plan.inventoryDigest !== input.inventoryDigest || plan.requestDigest !== input.requestDigest)
      throw new Error('Workload plan changed; observe and plan again');
    for (const value of plan.operations) {
      if (value.action === 'noop') continue;
      await client.query(`INSERT INTO identity_workloads (id,issuer,subject,client_id,display_name,permissions,scopes)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`, [value.id,value.issuer,value.subject,value.clientId,value.displayName,
        JSON.stringify(value.permissions),JSON.stringify(value.scopes)]);
    }
    return plan;
  });
}
