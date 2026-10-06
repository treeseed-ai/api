import { ControlPlaneStore,serializeTeamInvite } from "../../../../persistence/store.ts";
import type { NativeTeamInviteRow } from '../../../support/teams/teams.ts';
export async function getTeamInviteMethod(this: ControlPlaneStore, inviteId: string) {
    await this.ensureInitialized();
    return serializeTeamInvite(await this.first<NativeTeamInviteRow>(`SELECT * FROM team_invites WHERE id = ? LIMIT 1`, [inviteId]));
}
