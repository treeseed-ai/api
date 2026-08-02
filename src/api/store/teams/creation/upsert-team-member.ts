import { randomUUID } from 'node:crypto';
import { isoNow,MarketControlPlaneStore,normalizeTeamRoleKey } from "../../../persistence/store.ts";
export async function upsertTeamMemberMethod(this: MarketControlPlaneStore, teamId, userId, roleKey = 'contributor') {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const role = normalizeTeamRoleKey(roleKey);
    let membership = await this.first(`SELECT * FROM team_memberships WHERE team_id = ? AND user_id = ? LIMIT 1`, [teamId, userId]);
    if (!membership?.id) {
        const membershipId = randomUUID();
        await this.run(`INSERT INTO team_memberships (id, team_id, user_id, status, created_at, updated_at)
				 VALUES (?, ?, ?, 'active', ?, ?)`, [membershipId, teamId, userId, timestamp, timestamp]);
        membership = { id: membershipId };
    }
    else {
        await this.run(`UPDATE team_memberships SET status = 'active', updated_at = ? WHERE id = ?`, [timestamp, membership.id]);
    }
    await this.replaceMembershipRole(membership.id, role);
    return (await this.listTeamMembers(teamId)).find((member) => member.id === membership.id) ?? null;
}
