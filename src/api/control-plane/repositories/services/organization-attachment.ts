export interface OrganizationTransaction {
  query(sql: string, parameters?: any[]): Promise<{rows: any[]}>;
}
export interface OrganizationDatabase {
  transaction<T>(run: (transaction: OrganizationTransaction) => Promise<T>): Promise<T>;
}

/** Caller supplies the authenticated user identity, never an identity from the request body. */
export async function acceptOrganizationTeamInvitation(database: OrganizationDatabase, actorUserId: string,
  invitationId: string, expectedVersion: number) {
  if (!actorUserId) throw new Error('authentication_required');
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error('invalid_version');
  return database.transaction(async tx => {
    const invitation = (await tx.query(`SELECT *, expires_at > now() AS unexpired
      FROM organization_team_invitations WHERE id=$1 FOR UPDATE`, [invitationId])).rows[0];
    if (!invitation) throw new Error('invitation_unavailable');
    if (Number(invitation.version) !== expectedVersion) throw new Error('version_conflict');
    if (invitation.status !== 'pending' || !invitation.unexpired) throw new Error('invitation_inactive');
    // Serialize concurrent attachments, including invitations from different organizations.
    await tx.query('SELECT id FROM teams WHERE id=$1 FOR UPDATE', [invitation.team_id]);
    const owner = (await tx.query(`SELECT membership.id FROM team_memberships membership
      JOIN team_role_bindings binding ON binding.team_membership_id=membership.id
      JOIN roles role ON role.id=binding.role_id
      WHERE membership.team_id=$1 AND membership.user_id=$2 AND membership.status='active'
      AND role.key='team_owner' FOR SHARE OF membership,binding,role`, [invitation.team_id,actorUserId])).rows[0];
    if (!owner) throw new Error('team_owner_required');
    const organizationAuthority = (await tx.query(`SELECT user_id FROM organization_memberships
      WHERE organization_id=$1 AND user_id=$2 AND role IN ('owner','admin') FOR SHARE`,
    [invitation.organization_id,invitation.organization_authorized_by])).rows[0];
    if (!organizationAuthority) throw new Error('organization_authority_revoked');
    if ((await tx.query('SELECT team_id FROM organization_teams WHERE team_id=$1',[invitation.team_id])).rows.length)
      throw new Error('team_already_attached');
    await tx.query('INSERT INTO organization_teams(team_id,organization_id) VALUES ($1,$2)',[invitation.team_id,invitation.organization_id]);
    await tx.query(`UPDATE organization_team_invitations SET status='accepted', team_authorized_by=$1,
      version=version+1 WHERE id=$2`,[actorUserId,invitationId]);
    return {teamId:invitation.team_id,organizationId:invitation.organization_id,invitationId,version:expectedVersion+1};
  });
}
