import { randomUUID } from 'node:crypto';
import { isoNow,ControlPlaneStore,optionalStringValue,requireEnumValue } from "../../../../persistence/store.ts";
export async function voteCommonsProposalMethod(this: ControlPlaneStore, principal, proposalId, input: any = {}) {
    const vote = requireEnumValue(input.vote, new Set(['support', 'object', 'abstain']), 'Commons vote');
    const proposal = await this.getCommonsProposal(proposalId);
    if (!proposal)
        return null;
    if (proposal.status !== 'voting') {
        const error: Error & Record<string, any> = new Error('Proposal is not open for voting.');
        error.status = 409;
        throw error;
    }
    const participant = await this.ensureCommonsParticipantForPrincipal(principal);
    const snapshot = await this.createCommonsWeightSnapshot(participant.id, { action: 'vote', proposalId, vote });
    const timestamp = isoNow();
    const existing = await this.first(`SELECT * FROM commons_proposal_votes WHERE proposal_id = ? AND participant_id = ? LIMIT 1`, [proposalId, participant.id]);
    if (existing?.id) {
        await this.run(`UPDATE commons_proposal_votes SET vote = ?, weight_snapshot_id = ?, weight = ?, reason = ?, updated_at = ? WHERE id = ?`, [vote, snapshot.id, snapshot.totalWeight, optionalStringValue(input.reason), timestamp, existing.id]);
    }
    else {
        await this.run(`INSERT INTO commons_proposal_votes (
					id, proposal_id, participant_id, user_id, vote, weight_snapshot_id, weight, reason, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [randomUUID(), proposalId, participant.id, participant.userId, vote, snapshot.id, snapshot.totalWeight, optionalStringValue(input.reason), timestamp, timestamp]);
    }
    await this.recalculateCommonsProposalVoteTotals(proposalId);
    await this.recordCommonsGovernanceEvent({
        eventType: 'proposal.voted',
        actorType: 'user',
        actorId: principal.id,
        participantId: participant.id,
        proposalId,
        nextState: vote,
        message: optionalStringValue(input.reason),
        evidence: { weightSnapshotId: snapshot.id },
    });
    return this.getCommonsProposal(proposalId);
}
