import type {OrganizationDatabase, OrganizationTransaction} from './organization-attachment';

interface SelectionRequest {
  teamId: string; projectId: string; capability: string;
  environment: 'staging' | 'production' | 'shared';
  bindingId: string; explicitConnectionId?: string;
}
interface SelectionAuthority {
  /** Check the authenticated actor and project authority before reading any binding. */
  authorizeProject(tx: OrganizationTransaction): Promise<void>;
  /** Must check current owner/grant, provider scope and vault availability; never return secrets.
   * For a pinned binding, require its exact grant (no replacement or fallback).
   * An absent grant must fail; this operation never manufactures an automatic grant. */
  authorizeConnection(tx: OrganizationTransaction, connectionId: string,
    pinnedGrantId: string | null | undefined): Promise<{ownerTeamId: string; grantId: string | null}>;
}

/** Internal transactional selector. Public routes and policy publication must
 * supply trusted authority; database metadata alone never authorizes execution. */
export async function selectAndPinServiceBinding(database: OrganizationDatabase, request: SelectionRequest,
  authority: SelectionAuthority) {
  return database.transaction(async tx => {
    await authority.authorizeProject(tx);
    // Serialize first selection for this project, including stale RR snapshots.
    const project = (await tx.query('UPDATE projects SET id=id WHERE id=$1 AND team_id=$2 RETURNING id',
      [request.projectId,request.teamId])).rows[0];
    if (!project) throw new Error('project_unavailable');
    const pinned = (await tx.query(`SELECT * FROM project_service_bindings
      WHERE project_id=$1 AND capability=$2 AND environment=$3`,
    [request.projectId,request.capability,request.environment])).rows[0];
    if (pinned) {
      const access = await authority.authorizeConnection(tx,pinned.connection_id,pinned.grant_id);
      if (access.ownerTeamId!==pinned.owner_team_id || access.grantId!==pinned.grant_id)
        throw new Error('pinned_service_authority_changed');
      return {binding:pinned,created:false};
    }
    let connectionId = request.explicitConnectionId;
    if (!connectionId) {
      // Lock current membership so a concurrent removal cannot publish an org-derived binding.
      const membership = (await tx.query('SELECT organization_id FROM organization_teams WHERE team_id=$1 FOR SHARE',
        [request.teamId])).rows[0];
      const selected = (await tx.query(`SELECT connection_id FROM service_default_policies
        WHERE status='active' AND connection_id IS NOT NULL AND capability=$1 AND environment=$2
        AND ((scope='team' AND team_id=$3) OR (scope='organization' AND organization_id=$4) OR scope='deployment')
        ORDER BY CASE scope WHEN 'team' THEN 1 WHEN 'organization' THEN 2 ELSE 3 END LIMIT 1 FOR SHARE`,
      [request.capability,request.environment,request.teamId,membership?.organization_id??null])).rows[0];
      connectionId = selected?.connection_id;
    }
    if (!connectionId) throw new Error('service_binding_unavailable');
    // Authorization failure at the selected tier is terminal, not a reason to try another account.
    const access = await authority.authorizeConnection(tx,connectionId,undefined);
    const binding = (await tx.query(`INSERT INTO project_service_bindings
      (id,team_id,project_id,capability,environment,connection_id,owner_team_id,grant_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [request.bindingId,request.teamId,request.projectId,request.capability,request.environment,
      connectionId,access.ownerTeamId,access.grantId])).rows[0];
    return {binding,created:true};
  });
}
