import { isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function transitionCommonsProposalMethod(this: MarketControlPlaneStore, proposalId, nextState, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.getCommonsProposal(proposalId);
    if (!existing)
        return null;
    const timestamp = isoNow();
    const fields = ['status = ?', 'updated_at = ?'];
    const params = [nextState, timestamp];
    if (nextState === 'qualified') {
        fields.push('qualified_at = ?');
        params.push(timestamp);
    }
    if (nextState === 'voting') {
        fields.push('voting_starts_at = ?', 'voting_ends_at = ?');
        params.push(timestamp, input.votingEndsAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString());
    }
    if (['accepted', 'rejected', 'deferred'].includes(nextState)) {
        fields.push('steward_decision_at = ?', 'steward_decision_by = ?');
        params.push(timestamp, input.actorId ?? null);
    }
    params.push(proposalId);
    await this.run(`UPDATE commons_proposals SET ${fields.join(', ')} WHERE id = ?`, params);
    const eventMap = {
        submitted: 'proposal.submitted',
        qualified: 'proposal.qualified',
        under_review: 'proposal.review_started',
        voting: 'proposal.voting_started',
        accepted: 'proposal.steward_decision',
        rejected: 'proposal.steward_decision',
        deferred: 'proposal.steward_decision',
        archived: 'proposal.archived',
    };
    await this.recordCommonsGovernanceEvent({
        eventType: eventMap[nextState] ?? 'proposal.steward_decision',
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? null,
        participantId: existing.participantId,
        proposalId,
        priorState: existing.status,
        nextState,
        message: input.reason ?? null,
        evidence: input.evidence ?? {},
    });
    return this.getCommonsProposal(proposalId);
}
