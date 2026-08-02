import { isoNow,MarketControlPlaneStore,optionalStringValue,principalIsAdmin,serializeCommonsDelegation } from "../../../../persistence/store.ts";
export async function revokeCommonsDelegationMethod(this: MarketControlPlaneStore, principal, delegationId, input: any = {}) {
    const participant = await this.ensureCommonsParticipantForPrincipal(principal);
    const existing = await this.first(`SELECT * FROM commons_delegations WHERE id = ? LIMIT 1`, [delegationId]);
    if (!existing?.id)
        return null;
    if (existing.from_participant_id !== participant.id && !principalIsAdmin(principal)) {
        const error: Error & Record<string, any> = new Error('Permission denied.');
        error.status = 403;
        throw error;
    }
    const timestamp = isoNow();
    await this.run(`UPDATE commons_delegations SET status = 'revoked', revoked_at = ? WHERE id = ?`, [timestamp, delegationId]);
    await this.recordCommonsGovernanceEvent({
        eventType: 'delegation.revoked',
        actorType: 'user',
        actorId: principal.id,
        participantId: participant.id,
        priorState: existing.status,
        nextState: 'revoked',
        message: optionalStringValue(input.reason),
    });
    return serializeCommonsDelegation(await this.first(`SELECT * FROM commons_delegations WHERE id = ? LIMIT 1`, [delegationId]));
}
