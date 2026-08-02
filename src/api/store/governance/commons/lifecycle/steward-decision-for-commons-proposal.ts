import { randomUUID } from 'node:crypto';
import { isoNow,MarketControlPlaneStore,optionalStringValue,serializeCommonsDecision } from "../../../../persistence/store.ts";
export async function stewardDecisionForCommonsProposalMethod(this: MarketControlPlaneStore, proposalId, input: any = {}) {
    const status = ['accepted', 'rejected', 'deferred'].includes(input.status) ? input.status : 'accepted';
    const proposal = await this.transitionCommonsProposal(proposalId, status, input);
    if (!proposal)
        return null;
    const timestamp = isoNow();
    let decision = await this.first(`SELECT * FROM commons_decisions WHERE proposal_id = ? LIMIT 1`, [proposalId]);
    if (!decision?.id) {
        const id = randomUUID();
        await this.run(`INSERT INTO commons_decisions (
					id, proposal_id, status, decision_record_id, decision_record_slug, title, summary, steward_reason,
					capacity_budget, scheduled_for, implemented_at, metadata_json, created_at, updated_at
				) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`, [
            id,
            proposalId,
            status === 'accepted' ? 'accepted' : 'rejected',
            proposal.contentDecisionSlug,
            proposal.title,
            proposal.summary,
            optionalStringValue(input.reason),
            optionalStringValue(input.capacityBudget),
            optionalStringValue(input.scheduledFor),
            JSON.stringify(input.metadata ?? {}),
            timestamp,
            timestamp,
        ]);
        decision = await this.first(`SELECT * FROM commons_decisions WHERE id = ? LIMIT 1`, [id]);
    }
    else {
        await this.run(`UPDATE commons_decisions SET status = ?, steward_reason = ?, capacity_budget = ?, scheduled_for = ?, updated_at = ? WHERE id = ?`, [status === 'accepted' ? 'accepted' : 'rejected', optionalStringValue(input.reason), optionalStringValue(input.capacityBudget), optionalStringValue(input.scheduledFor), timestamp, decision.id]);
        decision = await this.first(`SELECT * FROM commons_decisions WHERE id = ? LIMIT 1`, [decision.id]);
    }
    await this.recordCommonsGovernanceEvent({
        eventType: 'decision.created',
        actorType: input.actorType ?? 'operator',
        actorId: input.actorId ?? null,
        participantId: proposal.participantId,
        proposalId,
        decisionId: decision.id,
        nextState: status,
        message: optionalStringValue(input.reason),
        evidence: input.evidence ?? {},
    });
    return { proposal, decision: serializeCommonsDecision(decision) };
}
