import { ControlPlaneStore,serializeTeam } from "../../../../persistence/store.ts";
import type { NativeTeamRow } from '../../../support/teams/teams.ts';
export async function getTeamMethod(this: ControlPlaneStore, teamId: string) {
    await this.ensureInitialized();
    return serializeTeam(await this.first<NativeTeamRow>(`SELECT * FROM teams WHERE id = ?`, [teamId]));
}
