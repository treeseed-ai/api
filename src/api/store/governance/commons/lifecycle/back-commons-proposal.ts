import { randomUUID } from 'node:crypto';
import { COMMONS_BACKING_THRESHOLD,COMMONS_WEIGHT_THRESHOLD,isoNow,ControlPlaneStore,optionalStringValue } from "../../../../persistence/store.ts";
export async function backCommonsProposalMethod(this: ControlPlaneStore, principal, proposalId, input: any = {}) {
    const proposal = await this.getCommonsProposal(proposalId);
    if (!proposal)
        return null;
    if (!['submitted', 'backing', 'qualified', 'under_review', 'voting'].includes(proposal.status)) {
        const error: Error & Record<string, any> = new Error('Proposal is not open for backing.');
        error.status = 409;
        throw error;
    }
    const participant = await this.ensureCommonsParticipantForPrincipal(principal);
    const snapshot = await this.createCommonsWeightSnapshot(participant.id, { action: 'backing', proposalId });
    const timestamp = isoNow();
    const existing = await this.first(`SELECT * FROM commons_proposal_backings WHERE proposal_id = ? AND participant_id = ? LIMIT 1`, [proposalId, participant.id]);
    if (!existing?.id) {
        await this.run(`INSERT INTO commons_proposal_backings (
					id, proposal_id, participant_id, user_id, weight_snapshot_id, weight, reason, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [randomUUID(), proposalId, participant.id, participant.userId, snapshot.id, snapshot.totalWeight, optionalStringValue(input.reason), timestamp]);
    }
    const aggregates = await this.first(`SELECT COUNT(*) AS backing_count, COALESCE(SUM(weight), 0) AS backing_weight
			 FROM commons_proposal_backings WHERE proposal_id = ?`, [proposalId]);
    const backingCount = Number(aggregates?.backing_count ?? 0);
    const backingWeight = Number(aggregates?.backing_weight ?? 0);
    const nextState = backingCount >= COMMONS_BACKING_THRESHOLD && backingWeight >= COMMONS_WEIGHT_THRESHOLD ? 'qualified' : 'backing';
    await this.run(`UPDATE commons_proposals SET status = ?, backing_count = ?, qualified_at = COALESCE(qualified_at, ?), updated_at = ? WHERE id = ?`, [nextState, backingCount, nextState === 'qualified' ? timestamp : null, timestamp, proposalId]);
    await this.recordCommonsGovernanceEvent({
        eventType: nextState === 'qualified' ? 'proposal.qualified' : 'proposal.backed',
        actorType: 'user',
        actorId: principal.id,
        participantId: participant.id,
        proposalId,
        priorState: proposal.status,
        nextState,
        message: optionalStringValue(input.reason),
        evidence: { backingCount, backingWeight, weightSnapshotId: snapshot.id },
    });
    return this.getCommonsProposal(proposalId);
}
