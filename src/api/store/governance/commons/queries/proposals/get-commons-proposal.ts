import { ControlPlaneStore,serializeCommonsProposal } from "../../../../../persistence/store.ts";
export async function getCommonsProposalMethod(this: ControlPlaneStore, proposalId) {
    await this.ensureInitialized();
    return serializeCommonsProposal(await this.first(`SELECT * FROM commons_proposals WHERE id = ? LIMIT 1`, [proposalId]));
}
