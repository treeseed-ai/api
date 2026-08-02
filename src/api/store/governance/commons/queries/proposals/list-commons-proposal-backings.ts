import { MarketControlPlaneStore,serializeCommonsProposalBacking } from "../../../../../persistence/store.ts";
export async function listCommonsProposalBackingsMethod(this: MarketControlPlaneStore, proposalId) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT * FROM commons_proposal_backings WHERE proposal_id = ? ORDER BY created_at ASC`, [proposalId]);
    return rows.map(serializeCommonsProposalBacking);
}
