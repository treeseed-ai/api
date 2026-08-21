import { governanceVotingProvider } from '@treeseed/sdk';
import { randomUUID } from 'node:crypto';
import { isoNow,ControlPlaneStore,objectValue,optionalStringValue,principalIsAdmin,requireEnumValue } from "../../../../persistence/store.ts";
import { assertExpectedProposalVersion,simulationEvidence } from '../support/simulation-evidence.ts';
export async function voteGovernanceProposalMethod(this: ControlPlaneStore, principal, proposalId, input: any = {}) {
    await this.ensureInitialized();
    const proposal = await this.getGovernanceProposal(proposalId);
    if (!proposal)
        return null;
    assertExpectedProposalVersion(input, proposal.activeVersion);
    if (proposal.status !== 'voting') {
        const error: Error & Record<string, any> = new Error('Proposal is not open for voting.');
        error.status = 409;
        throw error;
    }
    const vote = requireEnumValue(input.vote, new Set(['support', 'object', 'abstain']), 'Governance vote') as 'support' | 'object' | 'abstain';
    const snapshot = await this.latestGovernanceElectorateSnapshot(proposal.id, proposal.activeVersion);
    const eligible = snapshot?.eligibleVoters?.some((voter) => voter.userId === principal?.id);
    if (!eligible && !principalIsAdmin(principal)) {
        const error: Error & Record<string, any> = new Error('User is not eligible to vote on this proposal.');
        error.status = 403;
        throw error;
    }
    const timestamp = isoNow();
    const existing = await this.first(`SELECT * FROM governance_proposal_votes WHERE proposal_id = ? AND proposal_version = ? AND user_id = ? LIMIT 1`, [proposal.id, proposal.activeVersion, principal.id]);
    const provider = governanceVotingProvider(proposal.governanceProviderId);
    const normalized = provider.normalizeVote({
        proposalId: proposal.id,
        proposalVersion: proposal.activeVersion,
        userId: principal.id,
        vote,
        reason: optionalStringValue(input.reason),
        chamberOverrides: objectValue(input.chamberOverrides, {}),
    });
    if (existing?.id) {
        await this.run(`UPDATE governance_proposal_votes
				 SET vote = ?, reason = ?, chamber_votes_json = ?, updated_at = ?
				 WHERE id = ?`, [normalized.vote, normalized.reason, JSON.stringify(normalized.chamberVotes), timestamp, existing.id]);
    }
    else {
        await this.run(`INSERT INTO governance_proposal_votes (
					id, proposal_id, proposal_version, user_id, vote, reason, chamber_votes_json,
					effective_weights_json, delegated_from_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', '[]', ?, ?)`, [randomUUID(), proposal.id, proposal.activeVersion, principal.id, normalized.vote, normalized.reason, JSON.stringify(normalized.chamberVotes), timestamp, timestamp]);
    }
    await this.run(`INSERT INTO governance_vote_events (
				id, proposal_id, proposal_version, user_id, prior_vote, next_vote, reason, effective_weights_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)`, [randomUUID(), proposal.id, proposal.activeVersion, principal.id, existing?.vote ?? null, normalized.vote, normalized.reason, timestamp]);
    await this.recordGovernanceEvent({
        eventType: 'proposal.voted',
        actorType: 'user',
        actorId: principal.id,
        teamId: proposal.teamId,
        projectId: proposal.projectId,
        proposalId: proposal.id,
        proposalVersion: proposal.activeVersion,
        nextState: normalized.vote,
        message: normalized.reason,
        evidence: { priorVote: existing?.vote ?? null, ...simulationEvidence(input, principal?.id) },
    });
    return this.evaluateGovernanceProposal(proposal.id);
}
