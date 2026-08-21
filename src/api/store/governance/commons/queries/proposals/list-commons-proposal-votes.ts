import { ControlPlaneStore,serializeCommonsProposalVote } from "../../../../../persistence/store.ts";
export async function listCommonsProposalVotesMethod(this: ControlPlaneStore, proposalId) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT * FROM commons_proposal_votes WHERE proposal_id = ? ORDER BY updated_at ASC`, [proposalId]);
    return rows.map(serializeCommonsProposalVote);
}
