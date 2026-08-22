import { randomUUID } from 'node:crypto';
import { isoNow,ControlPlaneStore,serializeGovernanceEvent,stringValue } from "../../../../persistence/store.ts";
export async function recordGovernanceEventMethod(this: ControlPlaneStore, input: any = {}) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO governance_events (
				id, event_type, actor_type, actor_id, team_id, project_id, proposal_id, decision_id,
				proposal_version, prior_state, next_state, message, evidence_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        stringValue(input.eventType, 'governance.updated'),
        stringValue(input.actorType, 'system'),
        input.actorId ?? null,
        input.teamId,
        input.projectId ?? null,
        input.proposalId ?? null,
        input.decisionId ?? null,
        input.proposalVersion ?? null,
        input.priorState ?? null,
        input.nextState ?? null,
        input.message ?? null,
        JSON.stringify(input.evidence ?? {}),
        timestamp,
    ]);
    return serializeGovernanceEvent(await this.first(`SELECT * FROM governance_events WHERE id = ? LIMIT 1`, [id]));
}
