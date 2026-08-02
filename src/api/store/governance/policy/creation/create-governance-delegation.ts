import { randomUUID } from 'node:crypto';
import { arrayValue,isoNow,MarketControlPlaneStore,optionalStringValue,serializeGovernanceDelegation,stringValue } from "../../../../persistence/store.ts";
export async function createGovernanceDelegationMethod(this: MarketControlPlaneStore, principal, input: any = {}) {
    await this.ensureInitialized();
    const teamId = stringValue(input.teamId);
    const toUserId = stringValue(input.toUserId);
    if (!teamId || !principal?.id || !toUserId || toUserId === principal.id) {
        const error: Error & Record<string, any> = new Error('A team and different delegate user are required.');
        error.status = 400;
        throw error;
    }
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO governance_delegations (
				id, team_id, scope, from_user_id, to_user_id, chambers_json, status, reason,
				created_at, revoked_at, expires_at, metadata_json
			) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?)`, [
        id,
        teamId,
        optionalStringValue(input.scope, 'team'),
        principal.id,
        toUserId,
        JSON.stringify(arrayValue(input.chambers).length ? arrayValue(input.chambers) : ['member_chamber', 'stake_chamber']),
        optionalStringValue(input.reason),
        timestamp,
        input.expiresAt ?? null,
        JSON.stringify(input.metadata ?? {}),
    ]);
    await this.recordGovernanceEvent({
        eventType: 'delegation.created',
        actorType: 'user',
        actorId: principal.id,
        teamId,
        message: optionalStringValue(input.reason),
        evidence: { toUserId },
    });
    return serializeGovernanceDelegation(await this.first(`SELECT * FROM governance_delegations WHERE id = ? LIMIT 1`, [id]));
}
