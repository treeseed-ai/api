import { randomUUID } from 'node:crypto';
import { isoNow,MarketControlPlaneStore,serializeCommonsGovernanceEvent,stringValue } from "../../../../persistence/store.ts";
export async function recordCommonsGovernanceEventMethod(this: MarketControlPlaneStore, input: any = {}) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO commons_governance_events (
				id, event_type, actor_type, actor_id, participant_id, proposal_id, question_id, decision_id,
				prior_state, next_state, message, evidence_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        stringValue(input.eventType, 'decision.updated'),
        stringValue(input.actorType, 'system'),
        input.actorId ?? null,
        input.participantId ?? null,
        input.proposalId ?? null,
        input.questionId ?? null,
        input.decisionId ?? null,
        input.priorState ?? null,
        input.nextState ?? null,
        input.message ?? null,
        JSON.stringify(input.evidence ?? {}),
        timestamp,
    ]);
    return serializeCommonsGovernanceEvent(await this.first(`SELECT * FROM commons_governance_events WHERE id = ?`, [id]));
}
