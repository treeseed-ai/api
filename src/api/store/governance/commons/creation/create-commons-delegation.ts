import { randomUUID } from 'node:crypto';
import { isoNow,ControlPlaneStore,numberValue,optionalStringValue,serializeCommonsDelegation,stringValue } from "../../../../persistence/store.ts";
export async function createCommonsDelegationMethod(this: ControlPlaneStore, principal, input: any = {}) {
    const from = await this.ensureCommonsParticipantForPrincipal(principal);
    const toParticipantId = stringValue(input.toParticipantId);
    if (!toParticipantId || toParticipantId === from.id) {
        const error: Error & Record<string, any> = new Error('A different delegate participant is required.');
        error.status = 400;
        throw error;
    }
    const to = await this.getCommonsParticipant(toParticipantId);
    if (!to) {
        const error: Error & Record<string, any> = new Error('Delegate participant not found.');
        error.status = 404;
        throw error;
    }
    const scope = optionalStringValue(input.scope, 'treeseed_commons');
    const timestamp = isoNow();
    const id = randomUUID();
    await this.run(`INSERT INTO commons_delegations (
				id, from_participant_id, to_participant_id, scope, status, weight_limit, reason, created_at, revoked_at
			) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, NULL)`, [id, from.id, to.id, scope, numberValue(input.weightLimit, null), optionalStringValue(input.reason), timestamp]);
    await this.recordCommonsGovernanceEvent({
        eventType: 'delegation.created',
        actorType: 'user',
        actorId: principal.id,
        participantId: from.id,
        nextState: 'active',
        evidence: { toParticipantId: to.id, scope },
    });
    return serializeCommonsDelegation(await this.first(`SELECT * FROM commons_delegations WHERE id = ? LIMIT 1`, [id]));
}
