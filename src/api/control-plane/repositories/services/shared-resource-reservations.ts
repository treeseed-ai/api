import type {OrganizationDatabase, OrganizationTransaction} from './organization-attachment';

/** Internal primitive, not an endpoint. authorize must resolve the authenticated
 * actor, current memberships/audience, and exact operation scope in this same
 * transaction. The callback must not retrieve credentials or execute work. */
export async function reserveSharedResourceOperation(database: OrganizationDatabase,
  input: {grantId: string; operationKey: string; reservationId: string},
  authorize: (transaction: OrganizationTransaction, grant: Record<string, any>) => Promise<void>) {
  if (!input.grantId || !input.operationKey || !input.reservationId) throw new Error('invalid_reservation');
  return database.transaction(async tx => {
    // A write serializes both READ COMMITTED and stale REPEATABLE READ callers.
    // The authorization version is unchanged by acquiring a reservation lock.
    const grant = (await tx.query(`UPDATE shared_resource_grants SET version=version
      WHERE id=$1 RETURNING *, expires_at IS NULL OR expires_at>clock_timestamp() AS unexpired`,[input.grantId])).rows[0];
    if (!grant || grant.status!=='active' || !grant.unexpired) throw new Error('shared_grant_inactive');
    await authorize(tx,grant);
    const existing = (await tx.query(`SELECT id,status FROM shared_resource_operation_reservations
      WHERE grant_id=$1 AND operation_key=$2`,[input.grantId,input.operationKey])).rows[0];
    // Replay is not a new execution permit, even if the previous run failed.
    if (existing) return {reservationId:existing.id,status:existing.status,created:false};
    const usage = (await tx.query(`SELECT
      count(*) FILTER (WHERE status='active') AS concurrent,
      count(*) FILTER (WHERE created_at>clock_timestamp()-($2::double precision * interval '1 second')) AS window
      FROM shared_resource_operation_reservations WHERE grant_id=$1`,[input.grantId,grant.window_seconds])).rows[0];
    if (Number(usage.concurrent)>=Number(grant.max_concurrent_operations)) throw new Error('shared_grant_concurrency_exhausted');
    if (Number(usage.window)>=Number(grant.max_operations_per_window)) throw new Error('shared_grant_quota_exhausted');
    await tx.query(`INSERT INTO shared_resource_operation_reservations
      (id,grant_id,grant_version,operation_key,status,created_at) VALUES ($1,$2,$3,$4,'active',clock_timestamp())`,
    [input.reservationId,input.grantId,grant.version,input.operationKey]);
    return {reservationId:input.reservationId,status:'active',created:true};
  });
}
