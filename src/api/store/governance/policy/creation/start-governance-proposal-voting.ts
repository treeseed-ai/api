import { isoNow,MarketControlPlaneStore,optionalStringValue } from "../../../../persistence/store.ts";
import { assertExpectedProposalVersion,simulationEvidence } from '../support/simulation-evidence.ts';
import { assertGovernanceProposalReady } from '../contracts/governance-proposal-readiness.ts';
export async function startGovernanceProposalVotingMethod(this: MarketControlPlaneStore, principal, proposalId, input: any = {}) {
    await this.ensureInitialized();
    const proposal = await this.getGovernanceProposal(proposalId);
    if (!proposal)
        return null;
    assertExpectedProposalVersion(input, proposal.activeVersion);
    if (!['draft', 'open'].includes(proposal.status)) {
        const error: Error & Record<string, any> = new Error('Proposal is not open for voting.');
        error.status = 409;
        throw error;
    }
	await assertGovernanceProposalReady.call(this, proposalId, 'voting');
    const snapshot = await this.snapshotGovernanceElectorate(proposalId);
    const timestamp = isoNow();
    const votingEndsAt = optionalStringValue(input.votingEndsAt) ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await this.run(`UPDATE governance_proposals SET status = 'voting', voting_starts_at = ?, voting_ends_at = ?, updated_at = ? WHERE id = ?`, [timestamp, votingEndsAt, timestamp, proposalId]);
    await this.recordGovernanceEvent({
        eventType: 'proposal.voting_started',
        actorType: 'user',
        actorId: principal?.id ?? null,
        teamId: proposal.teamId,
        projectId: proposal.projectId,
        proposalId,
        proposalVersion: proposal.activeVersion,
        priorState: proposal.status,
        nextState: 'voting',
        message: optionalStringValue(input.reason),
        evidence: { electorateSnapshotId: snapshot?.id ?? null, ...simulationEvidence(input, principal?.id) },
    });
    return this.getGovernanceProposal(proposalId);
}
