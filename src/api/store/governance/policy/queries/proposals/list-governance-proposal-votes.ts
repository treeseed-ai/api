import { ControlPlaneStore,serializeGovernanceVote } from "../../../../../persistence/store.ts";
export async function listGovernanceProposalVotesMethod(this: ControlPlaneStore, proposalId, options: any = {}) {
    await this.ensureInitialized();
    const version = options.proposalVersion ?? (await this.getGovernanceProposal(proposalId))?.activeVersion;
    const rows = await this.all(`SELECT * FROM governance_proposal_votes WHERE proposal_id = ? AND proposal_version = ? ORDER BY updated_at ASC`, [proposalId, version]);
    return rows.map(serializeGovernanceVote);
}
