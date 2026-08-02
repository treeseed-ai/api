import { MarketControlPlaneStore,serializeTeamInvite } from "../../../../persistence/store.ts";
export async function getTeamInviteMethod(this: MarketControlPlaneStore, inviteId) {
    await this.ensureInitialized();
    return serializeTeamInvite(await this.first(`SELECT * FROM team_invites WHERE id = ? LIMIT 1`, [inviteId]));
}
