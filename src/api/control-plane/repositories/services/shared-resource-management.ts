import {SERVICE_MANAGEMENT_ROLES} from '../../../store/support/teams/teams';
import type {OrganizationDatabase, OrganizationTransaction} from './organization-attachment';

/** User-management path only: authenticated identity comes from the transport,
 * never from the request body. Workload principals need their own scoped resolver. */
export async function requireCurrentServiceManager(tx: OrganizationTransaction, userId: string, teamId: string) {
  if (!userId) throw new Error('authentication_required');
  const authority = (await tx.query(`SELECT membership.id FROM team_memberships membership
    JOIN users actor ON actor.id=membership.user_id
    JOIN teams team ON team.id=membership.team_id
    JOIN team_role_bindings binding ON binding.team_membership_id=membership.id
    JOIN roles role ON role.id=binding.role_id
    WHERE actor.id=$1 AND membership.team_id=$2 AND actor.status='active'
      AND team.status='active' AND membership.status='active' AND role.key=ANY($3::text[])
    FOR SHARE OF actor,team,membership,binding,role`,[userId,teamId,[...SERVICE_MANAGEMENT_ROLES]])).rows[0];
  if (!authority) throw new Error('service_management_denied');
}

/** Revocation affects admission immediately; it does not pretend to cancel an
 * already-running operation or revoke an upstream lease. */
export async function revokeOwnedSharedGrant(database: OrganizationDatabase, userId: string,
  teamId: string, grantId: string, expectedVersion: number) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion<1) throw new Error('invalid_version');
  return database.transaction(async tx => {
    await requireCurrentServiceManager(tx,userId,teamId);
    const grant = (await tx.query(`SELECT id,status,version FROM shared_resource_grants
      WHERE id=$1 AND owner_team_id=$2 FOR UPDATE`,[grantId,teamId])).rows[0];
    if (!grant) throw new Error('shared_grant_unavailable');
    if (Number(grant.version)!==expectedVersion) throw new Error('version_conflict');
    if (grant.status==='revoked') return {id:grant.id,status:'revoked',version:expectedVersion,changed:false};
    await tx.query("UPDATE shared_resource_grants SET status='revoked',version=version+1 WHERE id=$1",[grantId]);
    return {id:grant.id,status:'revoked',version:expectedVersion+1,changed:true};
  });
}
