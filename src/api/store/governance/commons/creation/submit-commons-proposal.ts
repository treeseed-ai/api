import { ControlPlaneStore } from "../../../../persistence/store.ts";
export async function submitCommonsProposalMethod(this: ControlPlaneStore, proposalId, input: any = {}) {
    const existing = await this.getCommonsProposal(proposalId);
    if (!existing || !['draft', 'submitted'].includes(existing.status))
        return existing;
    return this.transitionCommonsProposal(proposalId, 'submitted', input);
}
