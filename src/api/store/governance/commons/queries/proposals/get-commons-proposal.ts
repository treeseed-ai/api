import { MarketControlPlaneStore,serializeCommonsProposal } from "../../../../../persistence/store.ts";
export async function getCommonsProposalMethod(this: MarketControlPlaneStore, proposalId) {
    await this.ensureInitialized();
    return serializeCommonsProposal(await this.first(`SELECT * FROM commons_proposals WHERE id = ? LIMIT 1`, [proposalId]));
}
