import { ControlPlaneStore,serializeGovernanceProposal } from "../../../../../persistence/store.ts";
export async function getGovernanceProposalMethod(this: ControlPlaneStore, proposalId) {
    await this.ensureInitialized();
    return serializeGovernanceProposal(await this.first(`SELECT * FROM governance_proposals WHERE id = ? LIMIT 1`, [proposalId]));
}
