import { ControlPlaneStore,serializeGovernanceDelegation } from "../../../../persistence/store.ts";
export async function activeGovernanceDelegationSnapshotsMethod(this: ControlPlaneStore, teamId, scope = 'team') {
    const rows = await this.all(`SELECT * FROM governance_delegations
			 WHERE team_id = ? AND status = 'active' AND (scope = ? OR scope = 'team')
			 ORDER BY created_at ASC`, [teamId, scope]);
    return rows.map(serializeGovernanceDelegation).map((delegation) => ({
        id: delegation.id,
        fromUserId: delegation.fromUserId,
        toUserId: delegation.toUserId,
        scope: delegation.scope,
        chambers: delegation.chambers,
        status: delegation.status,
        reason: delegation.reason,
        createdAt: delegation.createdAt,
    }));
}
