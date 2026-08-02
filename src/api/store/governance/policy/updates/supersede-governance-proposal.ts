import { MarketControlPlaneStore,objectValue,optionalStringValue } from "../../../../persistence/store.ts";
export async function supersedeGovernanceProposalMethod(this: MarketControlPlaneStore, principal, proposalId, input: any = {}) {
    return this.transitionGovernanceProposal(proposalId, 'superseded', {
        actorType: 'user',
        actorId: principal?.id ?? null,
        reason: optionalStringValue(input.reason, 'Proposal superseded.'),
        evidence: {
            ...objectValue(input.evidence, {}),
            successorProposalId: optionalStringValue(input.successorProposalId) ?? null,
        },
    });
}
