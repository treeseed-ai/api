import { isoNow,MarketControlPlaneStore,optionalStringValue,principalIsAdmin,serializeGovernanceDelegation } from "../../../../persistence/store.ts";
export async function revokeGovernanceDelegationMethod(this: MarketControlPlaneStore, principal, delegationId, input: any = {}) {
    await this.ensureInitialized();
    const existing = serializeGovernanceDelegation(await this.first(`SELECT * FROM governance_delegations WHERE id = ? LIMIT 1`, [delegationId]));
    if (!existing)
        return null;
    if (existing.fromUserId !== principal?.id && !principalIsAdmin(principal)) {
        const error: Error & Record<string, any> = new Error('Permission denied.');
        error.status = 403;
        throw error;
    }
    const timestamp = isoNow();
    await this.run(`UPDATE governance_delegations SET status = 'revoked', revoked_at = ? WHERE id = ?`, [timestamp, delegationId]);
    await this.recordGovernanceEvent({
        eventType: 'delegation.revoked',
        actorType: 'user',
        actorId: principal?.id ?? null,
        teamId: existing.teamId,
        message: optionalStringValue(input.reason),
        evidence: { delegationId },
    });
    return serializeGovernanceDelegation(await this.first(`SELECT * FROM governance_delegations WHERE id = ? LIMIT 1`, [delegationId]));
}
