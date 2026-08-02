import { MarketControlPlaneStore,serializeTeamInvite } from "../../../../persistence/store.ts";
export async function listTeamInvitesMethod(this: MarketControlPlaneStore, teamId) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT team_invites.*,
            inviter.display_name AS invited_by_display_name,
            inviter.email AS invited_by_email
        FROM team_invites
        LEFT JOIN users inviter ON inviter.id = team_invites.invited_by_user_id
        WHERE team_invites.team_id = ? AND team_invites.status = 'pending'
        ORDER BY team_invites.created_at DESC`, [teamId]);
    return rows.map(serializeTeamInvite);
}
