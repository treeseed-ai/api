import { MarketControlPlaneStore } from "../../../../../persistence/store.ts";
export async function effectiveGovernanceVotesMethod(this: MarketControlPlaneStore, proposal) {
    const directVotes = await this.listGovernanceProposalVotes(proposal.id, { proposalVersion: proposal.activeVersion });
    const byUser = new Map(directVotes.map((vote) => [vote.userId, vote]));
    const snapshot = await this.latestGovernanceElectorateSnapshot(proposal.id, proposal.activeVersion);
    for (const delegation of snapshot?.delegations ?? []) {
        const delegateVote = byUser.get(delegation.toUserId);
        if (!delegateVote || byUser.has(delegation.fromUserId))
            continue;
        byUser.set(delegation.fromUserId, {
            ...delegateVote,
            id: `delegated:${delegateVote.id}:${delegation.fromUserId}`,
            userId: delegation.fromUserId,
            delegatedFrom: [delegation.toUserId],
        });
    }
    return [...byUser.values()];
}
