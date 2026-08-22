import { governanceVotingProvider } from '../../../../governance/voting.ts';
import { isoNow,ControlPlaneStore } from "../../../../persistence/store.ts";
import { assertExpectedProposalVersion, simulationEvidence } from '../support/simulation-evidence.ts';
export async function evaluateGovernanceProposalMethod(this: ControlPlaneStore, proposalId, input: any = {}) {
    await this.ensureInitialized();
    const proposal = await this.getGovernanceProposal(proposalId);
    if (!proposal)
        return null;
    assertExpectedProposalVersion(input, proposal.activeVersion);
    if (!['voting', 'open', 'draft'].includes(proposal.status))
        return proposal;
    const snapshot = await this.latestGovernanceElectorateSnapshot(proposal.id, proposal.activeVersion) ?? await this.snapshotGovernanceElectorate(proposal.id);
    const provider = governanceVotingProvider(proposal.governanceProviderId);
    const effectiveVotes = await this.effectiveGovernanceVotes(proposal) as Array<{
        userId: string;
        vote: string;
        reason?: string | null;
        chamberVotes?: Record<string, unknown>;
        effectiveWeights?: Record<string, unknown>;
        delegatedFrom?: string[];
    }>;
    const votes = effectiveVotes.map((vote) => ({
        userId: vote.userId,
        vote: vote.vote as 'support' | 'object' | 'abstain',
        reason: vote.reason,
        chamberVotes: vote.chamberVotes as Record<string, 'support' | 'object' | 'abstain'>,
        effectiveWeights: vote.effectiveWeights as Record<string, number>,
        delegatedFrom: vote.delegatedFrom,
    }));
    const outcome = provider.evaluate({
        now: input.now ?? isoNow(),
        votingEndsAt: proposal.votingEndsAt,
        electorate: {
            providerId: snapshot.providerId,
            providerVersion: snapshot.providerVersion,
            ruleSnapshot: snapshot.ruleSnapshot,
            chambers: snapshot.chambers,
            eligibleVoters: snapshot.eligibleVoters,
            delegations: snapshot.delegations,
            createdAt: snapshot.createdAt,
        },
        votes,
        adminDecision: input.adminDecision ?? null,
    });
    if (outcome.status === 'voting')
        return { ...proposal, outcome, votes };
    await this.transitionGovernanceProposal(proposal.id, outcome.status, {
        actorType: input.actorType ?? 'system',
        actorId: input.actorId ?? null,
        reason: outcome.reasonCode,
        evidence: { ...outcome.voteResult, ...simulationEvidence(input, input.actorId) },
    });
    if (outcome.status === 'accepted') {
        await this.createGovernanceDecisionFromProposal(proposal.id, {
            outcome,
            electorateSnapshotId: snapshot.id,
            actorType: input.actorType ?? 'system',
            actorId: input.actorId ?? null,
        });
    }
    return { ...(await this.getGovernanceProposal(proposal.id)), outcome, votes };
}
