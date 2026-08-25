import { isoNow,ControlPlaneStore } from "../../../../persistence/store.ts";
export async function transitionGovernanceProposalMethod(this: ControlPlaneStore, proposalId, nextState, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.getGovernanceProposal(proposalId);
    if (!existing)
        return null;
    const timestamp = isoNow();
    await this.run(`UPDATE governance_proposals SET status = ?, updated_at = ?, closed_at = ?, closed_reason = ? WHERE id = ?`, [
        nextState,
        timestamp,
        ['accepted', 'rejected', 'withdrawn', 'superseded', 'no_decision_quorum_failed'].includes(nextState) ? timestamp : existing.closedAt,
        input.reason ?? existing.closedReason ?? null,
        proposalId,
    ]);
    await this.recordGovernanceEvent({
        eventType: `proposal.${String(nextState).replace(/_/gu, '-')}`,
        actorType: input.actorType ?? 'system',
        actorId: input.actorId ?? null,
        teamId: existing.teamId,
        projectId: existing.projectId,
        proposalId,
        proposalVersion: existing.activeVersion,
        priorState: existing.status,
        nextState,
        message: input.reason ?? null,
        evidence: input.evidence ?? {},
    });
    return this.getGovernanceProposal(proposalId);
}
